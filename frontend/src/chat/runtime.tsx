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
import { completeChat, streamChat, type ChatMessage } from "../lib/chatApi";
import {
  appendMessage,
  deleteThread,
  getMemory,
  getThread,
  getThreadModel,
  getThreadTitle,
  listThreads,
  memoryWriteGen,
  readMemoryCache,
  renameThread,
  setMemory,
  setThreadModel,
  DEFAULT_MODEL,
  DEFAULT_TITLE,
} from "../lib/threadStore";
import { renderMemoryBlock, runExtraction } from "../lib/memory";

/**
 * Model id used for memory extraction. Picked to be small and cheap — the
 * extraction runs once per assistant turn off the visible reply path. The
 * RedPill proxy resolves this exactly as for chat; if the id is unavailable
 * the extraction call will fail and the in-flight guard releases (memory
 * silently stays at the prior doc).
 */
const MEMORY_EXTRACTION_MODEL = "openai/gpt-5-mini";

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
    async *run({ messages, abortSignal, context }) {
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

      for await (const text of streamChat({
        backendUrl: deps.backendUrl,
        sessionStore: deps.sessionStore,
        model: deps.modelRef.current || DEFAULT_MODEL,
        messages: payload,
        abortSignal,
      })) {
        yield { content: [{ type: "text", text }] };
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

function createHistoryAdapter(
  tcw: TinyCloudWeb,
  threadId: string,
  /** Triggered fire-and-forget after every assistant-turn append. */
  onAssistantTurn: (exchange: ChatMessage[]) => void,
): ThreadHistoryAdapter {
  // Per-thread rolling 2-item ring of the most recent user/assistant exchange.
  // Owned by the adapter (one ring per active thread instance) so a thread
  // switch can never feed extraction a stale exchange from a prior thread.
  const lastExchange: ChatMessage[] = [];
  return {
    async load(): Promise<ExportedMessageRepository> {
      const doc = await getThread(tcw, threadId);
      if (!doc) return { messages: [] };
      // Chat is linear (no branching). Rebuild a valid parent chain from the
      // stored order so MessageRepository.import never throws "parent not found"
      // on partial/legacy data. Drop any item lacking a message id.
      const valid = doc.messages.filter(
        (it) => typeof (it.message as { id?: unknown })?.id === "string",
      );
      if (valid.length === 0) return { messages: [] };
      const messages = valid.map((item, i) => ({
        ...item,
        parentId: i === 0 ? null : (valid[i - 1].message as { id: string }).id,
      }));
      const headId = (valid[valid.length - 1].message as { id: string }).id;
      return { headId, messages };
    },
    async append(item: ExportedMessageRepositoryItem): Promise<void> {
      await appendMessage(tcw, threadId, item);

      // Maintain a rolling 2-item ring of the most recent user/assistant
      // exchange. Extraction only ever needs the last turn pair, NOT the full
      // history — that's the cost optimization the plan calls for.
      const role = item.message?.role;
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
        () => createHistoryAdapter(activeTcw, threadId, onAssistantTurn),
        [activeTcw, threadId, onAssistantTurn],
      );

      // Sync the model picker with the active thread's stored model.
      useEffect(() => {
        if (!threadId || !onActiveThreadModel) return;
        let cancelled = false;
        (async () => {
          const model = await getThreadModel(activeTcw, threadId);
          if (!cancelled && model) onActiveThreadModel(model);
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
