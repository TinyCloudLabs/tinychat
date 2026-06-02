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
import { streamChat, type ChatMessage } from "../lib/chatApi";
import {
  appendMessage,
  deleteThread,
  getThread,
  getThreadModel,
  getThreadTitle,
  listThreads,
  renameThread,
  setThreadModel,
  DEFAULT_MODEL,
  DEFAULT_TITLE,
} from "../lib/threadStore";

export interface ChatRuntimeDeps {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  backendUrl: string;
  /** Live ref to the currently selected model id (set by the model picker). */
  modelRef: React.MutableRefObject<string>;
  /** Called when the active thread changes so the picker can sync its model. */
  onActiveThreadModel?: (model: string) => void;
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
    async *run({ messages, abortSignal }) {
      const payload: ChatMessage[] = [];
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

function createHistoryAdapter(tcw: TinyCloudWeb, threadId: string): ThreadHistoryAdapter {
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
        () => createHistoryAdapter(activeTcw, threadId),
        [activeTcw, threadId],
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

  return useRemoteThreadListRuntime({
    runtimeHook: function RuntimeHook() {
      // History is injected per-thread via RuntimeAdapterProvider in the
      // adapter's unstable_Provider; useLocalRuntime reads it from context.
      return useLocalRuntime(chatModel);
    },
    adapter,
  });
}

export { DEFAULT_MODEL, DEFAULT_TITLE, setThreadModel };
