import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  RuntimeAdapterProvider,
  useAuiState,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type AssistantRuntime,
  type ChatModelAdapter,
  type ExportedMessageRepository,
  type ExportedMessageRepositoryItem,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import {
  completeChat,
  emitReceipt,
  streamChat,
  type ChatMessage,
  type UsageInfo,
} from "../lib/chatApi";
import {
  appendMessage,
  deleteThread,
  getMemory,
  getThread,
  getThreadModel,
  getThreadTitle,
  isKnownThreadId,
  listThreads,
  memoryWriteGen,
  readMemoryCache,
  renameThread,
  setMemory,
  setThreadModel,
  subscribeThreadIndex,
  DEFAULT_MODEL,
  DEFAULT_TITLE,
  type ThreadDoc,
} from "../lib/threadStore";
import { historyPrefetch, setPrefetchFetcher } from "../lib/historyPrefetch";
import { renderMemoryBlock, runExtraction } from "../lib/memory";
import {
  createBillingClient,
  setReceipt,
  splitCredits,
  type RatesResponse,
} from "../lib/billingApi";
import { setCompletion, type RelaySignature } from "../lib/completionStore";
import { healPersistedModel } from "../lib/sanitizeModel";
import {
  setPendingCompletion,
  setPendingReceipt,
  takePendingCompletion,
  takePendingReceipt,
} from "./pendingHandoff";

/** Empty offered-set sentinel for the pre-/models-load sanitize path (ST1). */
const EMPTY_OFFERED: ReadonlySet<string> = new Set();

/**
 * Model id used for memory extraction. Picked to be small and cheap — the
 * extraction runs once per assistant turn off the visible reply path. It MUST be
 * a verifiable phala/* model (in VERIFIABLE_MODELS, not blocklisted) so the
 * extraction POST passes the phala/-only tier gate under the paywall; a non-phala
 * id is rejected with 402 and memory silently never updates (ST3). The RedPill
 * proxy resolves this exactly as for chat; if the id is unavailable the
 * extraction call fails and the in-flight guard releases (memory stays put).
 */
const MEMORY_EXTRACTION_MODEL = "phala/gpt-oss-20b";

/**
 * Per-call output cap on extraction. cl100k averages ~4 chars/token for
 * English prose, so the 4000-char doc budget can need ~1000 tokens; 1200
 * gives real headroom so the SSE stream never truncates mid-content and
 * persists a partial doc back to storage. Caps stream length on verbose
 * models.
 */
const MEMORY_EXTRACTION_MAX_TOKENS = 1200;

export interface ChatRuntimeDeps {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  backendUrl: string;
  /** Live ref to the currently selected model id (set by the model picker). */
  modelRef: React.MutableRefObject<string>;
  /** Called when the active thread changes so the picker can sync its model. */
  onActiveThreadModel?: (model: string) => void;
  /**
   * Live ref to the latest known memory doc for the active space. Read at
   * model-context request time so freshly-extracted memory shows up on the
   * NEXT turn without re-mounting the runtime. The MemoryPanel and the
   * background extraction both write through `setMemoryRef` below.
   */
  memoryRef: React.MutableRefObject<string | null>;
  /**
   * Called when extraction writes back a new doc (lets the panel re-render).
   * `null` represents a cleared doc; a string carries the latest content.
   */
  onMemoryUpdated?: (doc: string | null) => void;
}

// ── Receipt + completion handoff (per-thread; see pendingHandoff.ts) ──
//
// The receipt re-derives the charge from public data (rates + the SSE usage
// chunk) — see spec §5.3 — and the completion id wires the verification badge.
// Both are captured in `run()` and consumed in the next assistant `append()`.
// They are keyed PER THREAD (ST4) so two threads' interleaved stream finishes
// can never cross-contaminate each other's message metadata.

let cachedRatesPromise: Promise<RatesResponse> | null = null;
function getCachedRates(deps: ChatRuntimeDeps): Promise<RatesResponse> {
  if (!cachedRatesPromise) {
    const billing = createBillingClient(deps.backendUrl, deps.sessionStore);
    cachedRatesPromise = billing.getRates().catch((err) => {
      // Allow a retry on the next stream — receipts are UI sugar, never block chat.
      cachedRatesPromise = null;
      throw err;
    });
  }
  return cachedRatesPromise;
}

/** Flatten an assistant-ui ThreadMessage's content parts into plain text. */
function messageText(message: { content: readonly unknown[] }): string {
  return message.content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

// ── ChatModelAdapter (transport to the backend SSE proxy) ────────────

function createChatModelAdapter(deps: ChatRuntimeDeps): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, context, unstable_assistantMessageId }) {
      const payload: ChatMessage[] = [];

      // Prepend the merged model-context system prompt FIRST so memory (and
      // any other registered context provider) lands at the start of the
      // system content — the position least affected by context rot. The
      // existing payload filter at the for-loop below already accepts the
      // "system" role, so this matches the on-wire schema.
      const systemContent = context?.system;
      if (typeof systemContent === "string" && systemContent.length > 0) {
        payload.push({ role: "system", content: systemContent });
      }

      for (const m of messages) {
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
        const content = messageText(m);
        if (!content) continue;
        payload.push({ role: m.role, content });
      }

      const modelId = deps.modelRef.current || DEFAULT_MODEL;
      let lastUsage: UsageInfo | null = null;
      let completionId: string | null = null;
      let relaySignature: RelaySignature | null = null;

      for await (const text of streamChat({
        backendUrl: deps.backendUrl,
        sessionStore: deps.sessionStore,
        model: modelId,
        messages: payload,
        abortSignal,
        onUsage: (u) => {
          lastUsage = u;
        },
        onCompletionId: (id) => {
          completionId = id;
        },
        onRelaySignature: (frame) => {
          // Map the wire frame to the verifier-side (camelCase) shape. The
          // model/completion-id binding is re-derived from the completion ref,
          // so we keep only the signature payload here.
          relaySignature = {
            v: frame.v,
            contentSha256: frame.content_sha256,
            signature: frame.signature,
            address: frame.address,
          };
        },
      })) {
        yield { content: [{ type: "text", text }] };
      }

      // Stream completed cleanly. Stash the usage + completion id keyed by THIS
      // assistant message id (ST4) so its `append()`/receipt hook consumes
      // exactly its own handoff. Message ids are globally unique, so an
      // interleaved finish on another thread can never overwrite ours (the
      // module-slot race). `unstable_assistantMessageId` equals the id append()
      // sees as `item.message.id`. If it is absent the handoff simply no-ops (no
      // badge/receipt) — never a wrong one.
      if (unstable_assistantMessageId) {
        if (lastUsage) {
          setPendingReceipt(unstable_assistantMessageId, { usage: lastUsage, modelId });
        }
        if (completionId) {
          setPendingCompletion(unstable_assistantMessageId, {
            completionId,
            model: modelId,
            relaySignature: relaySignature ?? undefined,
          });
        }
      }
    },
  };
}

// ── Per-thread ThreadHistoryAdapter (TinyCloud KV) ───────────────────

/**
 * Pluck plain text from a stored message item's content parts. Mirrors
 * `messageText` above but takes the persisted `StoredMessageItem` shape
 * (each part is the same `{type, text}` object on the wire, but typed
 * loosely so we don't pull the persisted-item types in).
 */
function storedItemText(item: ExportedMessageRepositoryItem): string {
  const parts = (item.message?.content ?? []) as readonly unknown[];
  return parts
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/**
 * Persisted-receipt shape stored at the TOP LEVEL of an assistant message item
 * (sibling of `message`, never inside it — assistant-ui's MessageRepository.import
 * only reads `message`/`parentId` and ignores extra item fields, so this rides
 * along harmlessly). On reload, `load()` rehydrates the in-session store from it.
 */
interface PersistedReceipt {
  input: number;
  output: number;
  total: number;
  /** Id of the user message that opened the exchange (carries the input share). */
  userMessageId?: string;
  modelId: string;
}

/** True when `v` is a structurally valid PersistedReceipt. */
function isPersistedReceipt(v: unknown): v is PersistedReceipt {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.input === "number" &&
    typeof r.output === "number" &&
    typeof r.total === "number" &&
    typeof r.modelId === "string"
  );
}

/** Max time we'll wait for the receipt computation before persisting WITHOUT it. */
const RECEIPT_COMPUTE_TIMEOUT_MS = 1500;

/**
 * Build the assistant-ui repository from a stored ThreadDoc. Shared by the
 * prefetch-cache-hit path and the on-demand fetch path so both rehydrate
 * receipts and rebuild the parent chain identically.
 *
 * Chat is linear (no branching). Rebuild a valid parent chain from the stored
 * order so MessageRepository.import never throws "parent not found" on
 * partial/legacy data. Drop any item lacking a message id.
 */
function repositoryFromDoc(doc: ThreadDoc): ExportedMessageRepository {
  const valid = doc.messages.filter(
    (it) => typeof (it.message as { id?: unknown })?.id === "string",
  );
  if (valid.length === 0) return { messages: [] };
  // Rehydrate the in-session receipt store from any persisted receipts so the
  // per-message footers reappear after a reload. Do NOT emitReceipt here — that
  // would re-bump the usage meter for historical messages. The extra top-level
  // `receipt` field is ignored by MessageRepository.import (it only destructures
  // `message`/`parentId`), so we can leave it on the items handed back.
  for (const item of valid) {
    const receipt = (item as { receipt?: unknown }).receipt;
    if (!isPersistedReceipt(receipt)) continue;
    const assistantId = (item.message as { id: string }).id;
    if (typeof receipt.userMessageId === "string") {
      setReceipt(receipt.userMessageId, receipt.input, "input");
    }
    setReceipt(assistantId, receipt.output, "output");
  }
  const messages = valid.map((item, i) => ({
    ...item,
    parentId: i === 0 ? null : (valid[i - 1].message as { id: string }).id,
  }));
  const headId = (valid[valid.length - 1].message as { id: string }).id;
  return { headId, messages };
}

function createHistoryAdapter(
  tcw: TinyCloudWeb,
  threadId: string,
  /** Triggered fire-and-forget after every assistant-turn append. */
  onAssistantTurn: (exchange: ChatMessage[]) => void,
  /**
   * Computes the input/output split receipt for an assistant turn, applies it
   * to the in-session store (setReceipt both sides + emitReceipt once), and
   * resolves with the persistable receipt shape — or null when there's nothing
   * to record (no pending usage, unknown model, rates failure). Resolves fast
   * once rates are session-cached (the first call primes the cache). Called
   * BEFORE persistence so the result can be embedded in the stored item.
   */
  computeReceipt?: (
    messageId: string,
    userMessageId?: string,
  ) => Promise<PersistedReceipt | null>,
): ThreadHistoryAdapter {
  // Per-thread rolling 2-item ring of the most recent user/assistant exchange.
  // Owned by the adapter (one ring per active thread instance) so a thread
  // switch can never feed extraction a stale exchange from a prior thread.
  const lastExchange: ChatMessage[] = [];
  // Id of the most recently appended user message — paired with the assistant
  // message id below to register the split receipt (input vs. output share).
  let lastUserMessageId: string | undefined;
  return {
    async load(): Promise<ExportedMessageRepository> {
      // Brand-new threads have nothing persisted, but the runtime still fires
      // load() for them and keeps `thread.isLoading` on until it resolves —
      // which hides the welcome screen behind the in-flight SQL (~2-6s on
      // boot). A warm thread-index cache that does NOT contain this id proves
      // the thread was never persisted, so resolve instantly without I/O.
      //
      // PRECEDENCE: this membership short-circuit MUST stay FIRST — instant
      // new-chat (requirement #1) outranks every freshness path below.
      if (isKnownThreadId(tcw, threadId) === false) return { messages: [] };
      // Prefetched this session? Render from the in-memory cache instantly and
      // kick a background refresh of just this thread (promote dedupes against
      // any in-flight fetch — never double-fetches) so a re-open is fresh.
      const cached = historyPrefetch.get(threadId);
      if (cached) {
        void historyPrefetch.promote(threadId);
        return repositoryFromDoc(cached);
      }
      // Miss: promote to the front of the queue and await its fetch (the
      // HistorySkeleton shows meanwhile — acceptable and expected). The queue's
      // fetcher is `getThread`, so this is equivalent to a direct read but goes
      // through the single sequential pipe (concurrency-1 constraint).
      const doc = await historyPrefetch.promote(threadId);
      if (!doc) return { messages: [] };
      return repositoryFromDoc(doc);
    },
    async append(item: ExportedMessageRepositoryItem): Promise<void> {
      const role = item.message?.role;
      const id = (item.message as { id?: unknown })?.id;

      // Receipt hooks run at ENTRY, before persistence. The receipt only needs
      // the message ids — and `await appendMessage` is the wrong thing to gate
      // on: TinyCloud SQL calls are ~2s each and are known to DROP responses
      // under concurrency (same infra bug as the thread-list flashing fix), so
      // code below the await can run many seconds late or never. Verified live:
      // the post-await path never ran while the stream + ids were all ready.
      if (role === "user") {
        lastUserMessageId = typeof id === "string" ? id : undefined;
      }
      if (role === "assistant" && typeof id === "string" && computeReceipt) {
        // Compute the receipt (which also applies the live in-session store
        // footers + the single usage-bump emit) BEFORE persisting, so we can
        // embed it in the stored item. Race against a short timeout so a slow
        // rates fetch never blocks persistence: on timeout we persist WITHOUT
        // the receipt (the in-session footers still appear live this session;
        // they just won't survive reload — acceptable). Rates are session-cached
        // after the first call, so this normally resolves in microseconds.
        const receipt = await Promise.race([
          computeReceipt(id, lastUserMessageId).catch(() => null),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), RECEIPT_COMPUTE_TIMEOUT_MS),
          ),
        ]);
        if (receipt) {
          // Attach to the TOP-LEVEL item (sibling of `message`) — NOT inside
          // item.message, which assistant-ui's repository import inspects.
          (item as { receipt?: PersistedReceipt }).receipt = receipt;
        }
      }

      // Key the streamed completion id to this assistant message so the
      // verification badge can call verify(completionId, { model }). Read-and-
      // clear the single pending slot; never blocks persistence.
      if (role === "assistant" && typeof id === "string") {
        const pending = takePendingCompletion(id);
        if (pending) {
          setCompletion(id, {
            completionId: pending.completionId,
            model: pending.model,
            relaySignature: pending.relaySignature,
          });
        }
      }

      await appendMessage(tcw, threadId, item);

      // Maintain a rolling 2-item ring of the most recent user/assistant
      // exchange. Extraction only ever needs the last turn pair, NOT the full
      // history — that's the cost optimization the plan calls for.
      const text = storedItemText(item);
      if ((role === "user" || role === "assistant") && text) {
        lastExchange.push({ role, content: text });
        if (lastExchange.length > 2) lastExchange.splice(0, lastExchange.length - 2);
      }

      // Fire-and-forget extraction after an assistant turn — never await it
      // into the append path or the next user message stalls behind it.
      if (role === "assistant") {
        onAssistantTurn([...lastExchange]);
      }
    },
  };
}

// ── RemoteThreadListAdapter (sidebar, backed by KV docs) ─────────────
//
// `unstable_Provider` injects the per-thread history adapter for whichever
// thread is currently active (read via `useAuiState`).

function useThreadListAdapter(deps: ChatRuntimeDeps): RemoteThreadListAdapter {
  const { tcw } = deps;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // Point the prefetch queue at this session's `getThread`. Bound during render
  // (not in an effect) so the fetcher is in place before assistant-ui ever
  // calls the history adapter's load() — otherwise a miss could fetch through a
  // stale/default fetcher. Re-binds only when the account (tcw) changes.
  const fetcherTcwRef = useRef<TinyCloudWeb | null>(null);
  if (fetcherTcwRef.current !== tcw) {
    fetcherTcwRef.current = tcw;
    setPrefetchFetcher((id) => getThread(tcw, id));
  }

  const onAssistantTurn = useCallback((exchange: ChatMessage[]) => {
    const d = depsRef.current;
    void runExtraction(exchange, {
      complete: (messages, opts) =>
        completeChat({
          backendUrl: d.backendUrl,
          sessionStore: d.sessionStore,
          model: MEMORY_EXTRACTION_MODEL,
          messages,
          maxTokens: MEMORY_EXTRACTION_MAX_TOKENS,
          abortSignal: opts?.abortSignal,
        }),
      getDoc: async () => {
        // Prefer the live ref (already reconciled by getMemory on mount) so
        // we don't pay a SQL round-trip per assistant turn.
        const ref = d.memoryRef.current;
        if (ref !== null) return ref;
        return getMemory(d.tcw);
      },
      setDoc: async (next) => {
        d.memoryRef.current = next;
        d.onMemoryUpdated?.(next);
        await setMemory(d.tcw, next);
      },
      writeGen: memoryWriteGen,
    });
  }, []);

  const computeReceipt = useCallback(
    async (
      messageId: string,
      userMessageId?: string,
    ): Promise<PersistedReceipt | null> => {
      const d = depsRef.current;
      const pending = takePendingReceipt(messageId);
      if (!pending) return null;
      // On any failure (rates fetch, unknown model in catalog) we silently skip
      // the receipt; it's UI sugar, not the accounting source of truth. This is
      // awaited by append() (raced against a timeout), so it must never throw.
      try {
        const rates = await getCachedRates(d);
        const m = rates.models.find((r) => r.id === pending.modelId);
        if (!m) return null;
        // Split the charged total into input/output shares. The two footers
        // always sum to `total` (see splitCredits). Store the input share on
        // the user message and the output share on the assistant message.
        const { total, inputCredits, outputCredits } = splitCredits(
          m,
          pending.usage.promptTokens,
          pending.usage.completionTokens,
        );
        if (userMessageId) setReceipt(userMessageId, inputCredits, "input");
        setReceipt(messageId, outputCredits, "output");
        // Emit ONE receipt event carrying the TOTAL so App.tsx's optimistic
        // usage bump counts the charge exactly once (never per-side). The
        // store already holds both per-message footers; this event is only
        // the meter bump, keyed on the assistant message id.
        emitReceipt(messageId, total, pending.modelId);
        // Return the persistable shape so append() can embed it in the stored
        // item (survives reload). load() rehydrates the store from it but does
        // NOT re-emit (no historical usage-bump).
        return {
          input: inputCredits,
          output: outputCredits,
          total,
          userMessageId,
          modelId: pending.modelId,
        };
      } catch {
        return null;
      }
    },
    [],
  );

  const Provider = useCallback(
    function ThreadAdapterProvider({ children }: { children?: React.ReactNode }) {
      // A new thread has a stable local `id` (e.g. __LOCALID_…) but no
      // `remoteId` until `initialize` resolves one. The first user message is
      // appended BEFORE that resolution, so keying history on `remoteId` alone
      // routes it to an empty key (a shared garbage doc) while the assistant
      // reply lands under the real id — splitting one chat across two docs and
      // spawning title-less "New chat" orphans. Our `initialize` echoes the
      // local id back as the remoteId, so `remoteId ?? id` is stable for the
      // whole thread lifecycle and keeps every message in one doc.
      const threadId = useAuiState(
        (s) => s.threadListItem.remoteId ?? s.threadListItem.id,
      ) as string;
      const activeTcw = depsRef.current.tcw;
      const onActiveThreadModel = depsRef.current.onActiveThreadModel;

      const history = useMemo<ThreadHistoryAdapter>(
        () =>
          createHistoryAdapter(
            activeTcw,
            threadId,
            onAssistantTurn,
            computeReceipt,
          ),
        [activeTcw, threadId, onAssistantTurn, computeReceipt],
      );

      // Sync the model picker with the active thread's stored model.
      useEffect(() => {
        if (!threadId || !onActiveThreadModel) return;
        let cancelled = false;
        (async () => {
          const model = await getThreadModel(activeTcw, threadId);
          if (cancelled || !model) return;
          // ST1 — a pre-PR thread row can carry a stale non-offered model id.
          // Sanitize (phala/ prefix gate; the offered list lives in App, not
          // here) and, when it was non-offered, heal the thread row so it does
          // not recur on the next open.
          const { model: corrected, healed } = healPersistedModel(model, EMPTY_OFFERED);
          if (healed) {
            void setThreadModel(activeTcw, threadId, corrected).catch(() => {
              // Best-effort heal; the picker still shows the corrected value.
            });
          }
          if (!cancelled) onActiveThreadModel(corrected);
        })();
        return () => {
          cancelled = true;
        };
      }, [activeTcw, threadId, onActiveThreadModel]);

      const adapters = useMemo(() => ({ history }), [history]);
      return <RuntimeAdapterProvider adapters={adapters}>{children}</RuntimeAdapterProvider>;
    },
    [],
  );

  return useMemo<RemoteThreadListAdapter>(
    () => ({
      async list() {
        const summaries = await listThreads(tcw);
        return {
          threads: summaries.map((t) => ({
            status: "regular" as const,
            remoteId: t.id,
            title: t.title || DEFAULT_TITLE,
          })),
        };
      },
      async initialize(threadId: string) {
        // Do NOT persist here. Writing an empty doc on initialize spawns
        // orphan "New chat" entries (the runtime initializes a thread before
        // any message is sent). The KV doc is created lazily by appendMessage
        // on the first real message, so an empty thread never hits storage.
        return { remoteId: threadId, externalId: undefined };
      },
      async rename(remoteId: string, newTitle: string) {
        await renameThread(tcw, remoteId, newTitle);
      },
      async archive() {
        // Archiving is not surfaced in the UI; no-op.
      },
      async unarchive() {
        // no-op
      },
      async delete(remoteId: string) {
        await deleteThread(tcw, remoteId);
      },
      async generateTitle(remoteId: string) {
        // Titles are derived & persisted in the store from the first user
        // message. assistant-ui's RemoteThreadList calls this once after the
        // first run and optimistically applies the emitted text as the sidebar
        // title (instant, no list() refresh). So read the persisted title and
        // emit it as one text chunk. Guard against the default so a non-text
        // first message (no derived title) leaves the optimistic title as-is.
        const title = await getThreadTitle(tcw, remoteId).catch(() => null);
        return createAssistantStream((controller) => {
          if (title && title !== DEFAULT_TITLE) {
            controller.appendText(title);
          }
        });
      },
      async fetch(threadId: string) {
        const doc = await getThread(tcw, threadId);
        return {
          status: "regular" as const,
          remoteId: threadId,
          title: doc?.title || DEFAULT_TITLE,
        };
      },
      unstable_Provider: Provider,
    }),
    [tcw, Provider],
  );
}

/**
 * Wires the chat model transport + per-thread KV persistence + sidebar list
 * into a single assistant-ui runtime.
 *
 * Model selection flows through `deps.modelRef`: the picker writes to it, the
 * ChatModelAdapter reads `modelRef.current` at request time, and the persisted
 * per-thread model is loaded back into the picker when a thread activates.
 */
export function useChatRuntime(deps: ChatRuntimeDeps): AssistantRuntime {
  const adapter = useThreadListAdapter(deps);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const chatModel = useMemo(
    () => createChatModelAdapter(depsRef.current),
    // The adapter reads everything off depsRef at call time, so it is stable.
    [],
  );

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: function RuntimeHook() {
      // History is injected per-thread via RuntimeAdapterProvider in the
      // adapter's unstable_Provider; useLocalRuntime reads it from context.
      return useLocalRuntime(chatModel);
    },
    adapter,
  });

  // Sidebar freshness + background history prefetch.
  //
  // When the thread-list cache lands a list that differs from what's rendered
  // (the boot revalidate, or a mutation), threadStore fires subscribeThreadIndex.
  // We then (a) enqueue every known thread for newest-first background prefetch
  // (excluding the active one — it loads via the normal path), and (b) refresh
  // the assistant-ui thread list so the sidebar converges to server truth.
  //
  // Refresh mechanism: `runtime.threads.reload()` — the supported assistant-ui
  // API that re-calls the list adapter WITHOUT remounting and preserves the
  // active thread selection (guardrail C.3; C.2's remount concern is moot).
  // Guardrails C.1/C.4: never reload while a stream is running — defer until it
  // ends (the thread subscription flushes the pending refresh then).
  useEffect(() => {
    let pendingRefresh = false;

    const flushIfSafe = () => {
      if (!pendingRefresh) return;
      // C.1: never refresh while an assistant message stream is running.
      if (runtime.thread.getState().isRunning) return;
      pendingRefresh = false;
      void runtime.threads.reload();
    };

    const unsubIndex = subscribeThreadIndex((summaries, changed) => {
      // Wait-for-boot-critical-reads is already satisfied: this fires only after
      // listThreads' revalidate (or a mutation) has resolved. Enqueue newest-
      // first, sequential (concurrency-1 is enforced inside the queue).
      // NOT gated on `changed`: a typical boot revalidates to an UNCHANGED
      // list, and the prefetch still has to warm it.
      const activeId = runtime.thread.getState().threadId;
      historyPrefetch.enqueueAll(
        summaries.map((s) => s.id).filter((id) => id !== activeId),
      );
      // The sidebar reload IS gated on `changed` — identical lists never
      // trigger a needless refetch (and never risk the C.1 defer path).
      if (changed) {
        pendingRefresh = true;
        flushIfSafe();
      }
    });

    // A stream ending (or any active-thread state change) is the safe moment to
    // flush a refresh we deferred under guardrail C.1.
    const unsubRun = runtime.thread.subscribe(flushIfSafe);

    return () => {
      unsubIndex();
      unsubRun();
    };
  }, [runtime]);

  // Register the memory model-context provider on the top-level runtime.
  // The provider reads the live memoryRef at request time, so a freshly
  // extracted doc shows up on the NEXT turn without re-mounting anything.
  useEffect(() => {
    return runtime.registerModelContextProvider({
      getModelContext: () => ({ system: renderMemoryBlock(depsRef.current.memoryRef.current) }),
    });
  }, [runtime]);

  // Reconcile the in-memory ref from SQL once per space — instant paint
  // already happened from the readMemoryCache call in App, but the SQL row
  // is the source of truth (another device may have edited it).
  // Race guard: snapshot memoryWriteGen before the read; if a write
  // (extraction or save) happened during the round-trip, skip the assignment
  // so the stale SQL value can't roll back a newer ref.
  useEffect(() => {
    let cancelled = false;
    const startGen = memoryWriteGen();
    (async () => {
      const sqlDoc = await getMemory(deps.tcw).catch(() => null);
      if (cancelled) return;
      if (
        sqlDoc !== null
        && sqlDoc !== deps.memoryRef.current
        && memoryWriteGen() === startGen
      ) {
        deps.memoryRef.current = sqlDoc;
        deps.onMemoryUpdated?.(sqlDoc);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only the space (tcw) changing should trigger a re-reconcile; the ref
    // and callback are read off `deps` at call time and are stable for a
    // given space.
  }, [deps.tcw]);

  return runtime;
}

export { DEFAULT_MODEL, DEFAULT_TITLE, readMemoryCache, setThreadModel };
