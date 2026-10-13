import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import "../index.css";
import { offeredChatModelContextTokens } from "@tinyboilerplate/core";
import { useChatRuntime } from "./runtime";
import { Thread } from "./Thread";
import type { SelectionView, ModelSelectionController } from "./modelSelection";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import { DEFAULT_CONTEXT_TOKENS } from "./compaction";
import { promotedCanvasForTurn } from "../lib/conversationCanvasStore";
import { createRuntimeShim } from "../harness/runtimeShim";

declare global {
  interface Window {
    routerHarness?: {
      send: (text?: string) => void;
      switchExisting: () => Promise<void>;
      switchNew: () => Promise<void>;
      switchTo: (id: string) => Promise<void>;
      cancel: () => void;
      releaseInsert: () => void;
      releaseSave: () => void;
      releaseExtraction: () => void;
      rows: () => Array<[string, { model: string }]>;
      pick: (model: string) => void;
      retry: () => void;
      releaseRestore: () => void;
      events: string[];
      view: () => SelectionView;
      messageIds: (id: string) => string[];
    };
  }
}

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "healthy";
const {
  events,
  savedId,
  rows,
  messages,
  tcw,
  sessionStore,
  releaseInsert,
  releaseSave,
  releaseExtraction,
  releaseRestore,
} = createRuntimeShim({ scenario, canvas: params.get("canvas") === "1" });

const EMPTY_VIEW: SelectionView = {
  threadId: null,
  phase: "choosing",
  model: null,
  revision: 0,
  saving: false,
  saveFailed: false,
  canSend: false,
  canPick: false,
};

function Harness() {
  const [view, setView] = useState(EMPTY_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const controllerRef = useRef<ModelSelectionController | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const agentEnabledRef = useRef(false);
  const privateAccessRef = useRef({ active: true, revision: "fixture", generation: 0 });
  const memoryRef = useRef<string | null>(null);
  const registry = useMemo(() => createMeetingMessageRegistry(), []);
  const runtime = useChatRuntime(useMemo(() => ({
    tcw,
    sessionStore,
    backendUrl: location.origin,
    selectionControllerRef: controllerRef,
    onSelectionView: (next: SelectionView) => {
      events.push(`view:${next.threadId}:${next.phase}:${next.model ?? "none"}:${next.message ?? ""}`);
      setView(next);
    },
    onSelectionAuthFailure: () => events.push("auth-failure"),
    memoryRef,
    activeThreadIdRef,
    agentEnabledRef,
    privateAccessRef,
    meetingMessageRegistry: registry,
    getPromotedCanvas: (threadId: string) => promotedCanvasForTurn(tcw, threadId),
    getCheckpoint: async () => null,
    appendCompaction: async () => { throw new Error("unexpected compaction"); },
    summarize: async () => { throw new Error("unexpected summary"); },
    contextTokensFor: (model: string) => offeredChatModelContextTokens(model) ?? DEFAULT_CONTEXT_TOKENS,
  }), [registry]));

  useEffect(() => {
    window.routerHarness = {
      send: (text = "hello") => runtime.thread.append({
        role: "user",
        content: [{ type: "text", text }],
        startRun: true,
      }),
      switchExisting: () => runtime.threads.switchToThread(savedId),
      switchNew: () => runtime.threads.switchToNewThread(),
      switchTo: (id) => runtime.threads.switchToThread(id),
      cancel: () => runtime.thread.cancelRun(),
      releaseInsert,
      releaseSave,
      releaseExtraction,
      rows: () => [...rows],
      pick: (model) => controllerRef.current?.pick(model),
      retry: () => controllerRef.current?.retry(),
      releaseRestore,
      events,
      view: () => viewRef.current,
      messageIds: (id) => (messages.get(id) ?? []).map((payload) => JSON.parse(payload).message.id),
    };
  }, [runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread tcw={tcw} selection={view} onRetrySelection={() => controllerRef.current?.retry()} onReload={() => {}} canvasEnabled={params.get("canvas") === "1"} />
      <div id="phase">{view.phase}</div>
      <div id="model">{view.model ?? "none"}</div>
      <div id="message">{view.message ?? ""}</div>
      <div id="sendable">{String(view.canSend)}</div>
    </AssistantRuntimeProvider>
  );
}

createRoot(document.getElementById("root")!).render(scenario.includes("strict") ? <React.StrictMode><Harness /></React.StrictMode> : <Harness />);
