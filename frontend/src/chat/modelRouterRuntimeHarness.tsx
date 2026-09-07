import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { useChatRuntime } from "./runtime";
import { Thread } from "./Thread";
import type { SelectionView, ModelSelectionController } from "./modelSelection";
import { createMeetingMessageRegistry } from "./pendingHandoff";

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
    };
  }
}

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "healthy";
const events: string[] = [];
const savedId = "saved-thread";
const rows = new Map<string, { title: string; model: string; updatedAt: string }>();
const messages = new Map<string, string[]>();
if (scenario.includes("reopen") || scenario.includes("restore") || scenario.includes("cancel-lookup")) {
  rows.set(savedId, {
    title: "Saved",
    model: scenario.includes("retired") ? "deepseek/deepseek-v4-flash-0731" : OFFERED_CHAT_MODELS[2].id,
    updatedAt: "2026-09-07T14:00:00.000Z",
  });
  messages.set(savedId, [JSON.stringify({
    message: { id: "old-user", role: "user", content: [{ type: "text", text: "old" }] },
  })]);
}

let restoreRelease!: () => void;
let restoreGate = new Promise<void>((resolve) => { restoreRelease = resolve; });
let failRestore = scenario.includes("restore-fail");
let failSave = scenario.includes("save-fail");
let failInsert = scenario.includes("insert-fail");
let releaseInsert!: () => void;
const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
let releaseExtraction!: () => void;
const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
let releaseSave!: () => void;
const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });

const sql = {
  async query(statement: string, values: unknown[] = []) {
    if (statement.includes("SELECT id, title, model, updated_at FROM threads")) {
      return { ok: true, data: { rows: [...rows].map(([id, row]) => [id, row.title, row.model, row.updatedAt]) } };
    }
    if (statement.includes("SELECT model FROM threads")) {
      if (scenario.includes("restore-delay")) await restoreGate;
      if (failRestore) {
        failRestore = false;
        return { ok: false, error: { code: "READ_FAILED", message: "controlled read failure" } };
      }
      const row = scenario.includes("missing") ? undefined : rows.get(String(values[0]));
      return { ok: true, data: { rows: row ? [[row.model]] : [] } };
    }
    if (statement.includes("SELECT id, title, model, created_at, updated_at FROM threads")) {
      const id = String(values[0]);
      const row = rows.get(id);
      return { ok: true, data: { rows: row ? [[id, row.title, row.model, row.updatedAt, row.updatedAt]] : [] } };
    }
    if (statement.includes("SELECT payload FROM messages")) {
      return { ok: true, data: { rows: (messages.get(String(values[0])) ?? []).map((payload) => [payload]) } };
    }
    if (statement.includes("SELECT content FROM memory") && scenario.includes("extraction-delay") && events.includes("assistant-stored")) {
      events.push("extraction-waiting");
      await extractionGate;
    }
    if (statement.includes("SELECT content FROM memory") || statement.includes("FROM compactions")) {
      return { ok: true, data: { rows: [] } };
    }
    if (statement.includes("SELECT title FROM threads")) {
      const row = rows.get(String(values[0]));
      return { ok: true, data: { rows: row ? [[row.title]] : [] } };
    }
    return { ok: true, data: { rows: [] } };
  },
  async execute(statement: string, values: unknown[] = []) {
    if (statement.startsWith("UPDATE threads SET model")) {
      if (scenario.includes("save-delay")) await saveGate;
      if (failSave) { failSave = false; return { ok: false, error: { code: "SAVE", message: "controlled save failure" } }; }
      const id = String(values[2]);
      const row = rows.get(id);
      if (row) row.model = String(values[0]);
      events.push(`model:${id}:${String(values[0])}`);
    }
    return { ok: true, data: { rows: [] } };
  },
  async batch(operations: Array<{ sql: string; params?: unknown[] }>) {
    if (operations.some((operation) => operation.sql.includes("CREATE TABLE"))) {
      return { ok: true, data: { rows: [] } };
    }
    const threadInsert = operations.find((operation) => operation.sql.includes("INSERT INTO threads"));
    const messageInsert = operations.find((operation) => operation.sql.includes("INSERT INTO messages"));
    if (threadInsert && messageInsert) {
      events.push("insert-entered");
      if (scenario.includes("insert-delay")) await insertGate;
      if (failInsert) { failInsert = false; return { ok: false, error: { code: "INSERT", message: "controlled insert failure" } }; }
      const id = String(threadInsert.params?.[0]);
      const model = String(threadInsert.params?.[2]);
      const payload = String(messageInsert.params?.[2]);
      const row = rows.get(id);
      rows.set(id, {
        title: String(threadInsert.params?.[1]),
        model: row?.model ?? model,
        updatedAt: String(threadInsert.params?.[4]),
      });
      messages.set(id, [...(messages.get(id) ?? []), payload]);
      events.push(`append:${id}:${model}:${JSON.parse(payload).message.id}`);
      if (JSON.parse(payload).message.role === "assistant") events.push("assistant-stored");
    }
    return { ok: true, data: { rows: [] } };
  },
};

const tcw = {
  did: "did:test:runtime-harness",
  sql: { db: () => sql },
} as never;

const sessionStore = {
  getToken: () => "test-token",
  isExpired: () => false,
  hasSession: () => true,
  clear: () => events.push("auth-clear"),
} as never;

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
    meetingMessageRegistry: registry,
    getCheckpoint: async () => null,
    appendCompaction: async () => { throw new Error("unexpected compaction"); },
    summarize: async () => { throw new Error("unexpected summary"); },
    contextTokensFor: () => 1_048_576,
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
      releaseRestore: () => {
        restoreRelease();
        restoreGate = Promise.resolve();
      },
      events,
      view: () => viewRef.current,
    };
  }, [runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread tcw={tcw} selection={view} onRetrySelection={() => controllerRef.current?.retry()} onReload={() => {}} />
      <div id="phase">{view.phase}</div>
      <div id="model">{view.model ?? "none"}</div>
      <div id="message">{view.message ?? ""}</div>
      <div id="sendable">{String(view.canSend)}</div>
    </AssistantRuntimeProvider>
  );
}

createRoot(document.getElementById("root")!).render(scenario.includes("strict") ? <React.StrictMode><Harness /></React.StrictMode> : <Harness />);
