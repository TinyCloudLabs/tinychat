// In-memory stand-ins for the user's TinyCloud space (threads, messages and
// settings in SQL) and the backend session, so a browser harness can mount the
// real chat runtime with no network. Taken from the model-router harness.
//
// The scenario string seeds a saved thread and holds writes at gates the
// harness releases; see test/model-router-runtime.e2e.test.ts. The default,
// "healthy", is an empty store with nothing held.
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { useLocalCanvasStorage } from "../lib/conversationCanvasStore";

export function createRuntimeShim({ scenario = "healthy", canvas = false }: { scenario?: string; canvas?: boolean } = {}) {
  const events: string[] = [];
  const savedId = "saved-thread";
  const rows = new Map<string, { title: string; model: string; updatedAt: string }>();
  const messages = new Map<string, string[]>();
  const settings = new Map<string, string>();
  // `canvas` stands for an account that turned Canvas on in Settings.
  if (canvas) settings.set("conversation-canvas-enabled", "true");
  if (scenario.includes("reopen") || scenario.includes("restore") || scenario.includes("cancel-lookup")) {
    rows.set(savedId, {
      title: "Saved",
      model: scenario.includes("retired") ? "deepseek/deepseek-v4-flash-0731" : OFFERED_CHAT_MODELS[2].id,
      updatedAt: "2026-09-07T14:00:00.000Z",
    });
    messages.set(savedId, [
      JSON.stringify({
        message: {
          id: "old-user",
          role: "user",
          content: [{ type: "text", text: "old question" }],
          createdAt: "2026-09-07T14:00:00.000Z",
          attachments: [],
          metadata: { custom: {} },
        },
      }),
      ...(scenario.includes("canvas") ? [JSON.stringify({
        message: {
          id: "old-assistant",
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          createdAt: "2026-09-07T14:00:01.000Z",
          status: { type: "complete", reason: "stop" },
          metadata: {
            unstable_state: null,
            unstable_annotations: [],
            unstable_data: [],
            steps: [],
            custom: {},
          },
        },
      })] : []),
    ]);
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
      if (statement.includes("FROM settings WHERE key >= ?")) {
        const [from, to] = values.map(String);
        return { ok: true, data: { rows: [...settings].filter(([key]) => key >= from && key < to) } };
      }
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
      if (statement.startsWith("INSERT INTO settings")) settings.set(String(values[0]), String(values[1]));
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
      if (operations[0]?.sql.includes("SELECT NULL, NULL, NULL, NULL")) {
        // Branch rewrite: a guard (expected count + last payload), then the new history.
        const [id, count, , last] = (operations[0].params ?? []).map(String);
        const stored = messages.get(id) ?? [];
        if (String(stored.length) !== count || (stored.at(-1) ?? "") !== last) {
          return { ok: false, error: { code: "SQL", message: "NOT NULL constraint failed: messages.thread_id" } };
        }
        const payloads = operations.filter((operation) => operation.sql.startsWith("INSERT INTO messages (thread_id, position, payload, created_at) VALUES")).map((operation) => String(operation.params?.[2]));
        messages.set(id, payloads);
        events.push(`replace:${id}:${payloads.map((payload) => JSON.parse(payload).message.id).join(",")}`);
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

  const tcw = useLocalCanvasStorage({
    did: "did:test:runtime-harness",
    sql: { db: () => sql },
  } as never);

  const sessionStore = {
    getToken: () => "test-token",
    isExpired: () => false,
    hasSession: () => true,
    clear: () => events.push("auth-clear"),
  } as never;

  return {
    events,
    savedId,
    rows,
    messages,
    tcw,
    sessionStore,
    releaseInsert,
    releaseSave,
    releaseExtraction,
    releaseRestore: () => {
      restoreRelease();
      restoreGate = Promise.resolve();
    },
  };
}
