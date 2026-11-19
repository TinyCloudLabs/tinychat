import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { appendMessage, DEFAULT_TITLE, getThread, listThreads, normalizeUserTitle, setThreadTitle, useLocalThreadStorage, deleteThread } from "./threadStore";

class SqlService {
  readonly sqlite = new Database(":memory:");
  beforeBatch: (() => void) | null = null;
  query = async (sql: string, params: unknown[] = []) => {
    try {
      return { ok: true as const, data: { rows: this.sqlite.query(sql).values(...(params as never[])) } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL", message: String(error) } };
    }
  };
  execute = async (sql: string, params: unknown[] = []) => {
    try {
      this.sqlite.query(sql).run(...(params as never[]));
      return { ok: true as const, data: { rows: [] } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL", message: String(error) } };
    }
  };
  batch = async (operations: Array<{ sql: string; params?: unknown[] }>) => {
    try {
      this.beforeBatch?.();
      this.beforeBatch = null;
      this.sqlite.run("BEGIN");
      try {
        for (const op of operations) this.sqlite.query(op.sql).run(...((op.params ?? []) as never[]));
        this.sqlite.run("COMMIT");
      } catch (error) {
        this.sqlite.run("ROLLBACK");
        throw error;
      }
      return { ok: true as const, data: { rows: [] } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL", message: String(error) } };
    }
  };
  /** What another device would write: the same two rows, straight into the database. */
  renameElsewhere(id: string, title: string) {
    this.sqlite.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')", [`thread-title-user:${id}`]);
    this.sqlite.run("UPDATE threads SET title = ? WHERE id = ?", [title, id]);
  }
}

function tcwFor(service: SqlService): TinyCloudWeb {
  return { did: `did:test:${crypto.randomUUID()}`, sql: { db: () => service } } as unknown as TinyCloudWeb;
}

const user = (id: string, text: string) => ({ message: { id, role: "user", content: [{ type: "text", text }] } }) as never;
const assistant = (id: string, text: string) => ({ message: { id, role: "assistant", content: [{ type: "text", text }] } }) as never;

function titleRow(service: SqlService, id: string): string | null {
  const rows = service.sqlite.query("SELECT title FROM threads WHERE id = ?").values(id);
  return rows.length ? String(rows[0]![0]) : null;
}
function marker(service: SqlService, id: string): boolean {
  return service.sqlite.query("SELECT 1 FROM settings WHERE key = ?").values(`thread-title-user:${id}`).length > 0;
}

describe("renaming a chat", () => {
  test("the title and its user-set marker are stored in the space database", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "Plan the offsite"));
    expect(titleRow(service, "t1")).toBe("Plan the offsite");
    expect(marker(service, "t1")).toBe(false);

    await setThreadTitle(tcw, "t1", "  Offsite   plan ");
    expect(titleRow(service, "t1")).toBe("Offsite plan");
    expect(service.sqlite.query("SELECT key, value FROM settings").values()).toEqual([["thread-title-user:t1", "1"]]);
    expect((await listThreads(tcw))[0]?.title).toBe("Offsite plan");
    expect((await getThread(tcw, "t1"))?.title).toBe("Offsite plan");
  });

  test("a later message does not retitle a renamed chat", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "First"));
    await setThreadTitle(tcw, "t1", "Mine");
    await appendMessage(tcw, "t1", assistant("m2", "Reply"));
    await appendMessage(tcw, "t1", user("m3", "Second"));
    expect(titleRow(service, "t1")).toBe("Mine");
  });

  test("a rename that lands between the auto-title's read and write wins", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "x"));
    // Back to the default title so the next user message derives one.
    service.sqlite.run("UPDATE threads SET title = ? WHERE id = ?", [DEFAULT_TITLE, "t1"]);
    service.beforeBatch = () => service.renameElsewhere("t1", "Renamed meanwhile");
    await appendMessage(tcw, "t1", user("m2", "Derived title text"));
    expect(titleRow(service, "t1")).toBe("Renamed meanwhile");
    expect((await listThreads(tcw))[0]?.title).toBe("Renamed meanwhile");
  });

  test("a chat renamed to the default title stays that title", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "First"));
    await setThreadTitle(tcw, "t1", DEFAULT_TITLE);
    await appendMessage(tcw, "t1", user("m2", "Second"));
    expect(titleRow(service, "t1")).toBe(DEFAULT_TITLE);
  });

  test("clearing the title returns to the auto title and re-enables auto-titling", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "Original question"));
    await setThreadTitle(tcw, "t1", "Mine");
    await setThreadTitle(tcw, "t1", "   ");
    expect(titleRow(service, "t1")).toBe("Original question");
    expect(marker(service, "t1")).toBe(false);

    service.sqlite.run("UPDATE threads SET title = ? WHERE id = ?", [DEFAULT_TITLE, "t1"]);
    await appendMessage(tcw, "t1", user("m2", "Another"));
    expect(titleRow(service, "t1")).toBe("Another");
  });

  test("deleting a chat removes its marker", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "First"));
    await setThreadTitle(tcw, "t1", "Mine");
    await deleteThread(tcw, "t1");
    expect(marker(service, "t1")).toBe(false);
  });

  test("renaming a chat that does not exist stores nothing", async () => {
    const service = new SqlService();
    const tcw = tcwFor(service);
    await appendMessage(tcw, "t1", user("m1", "First"));
    await setThreadTitle(tcw, "ghost", "Nope");
    expect(marker(service, "ghost")).toBe(false);
  });

  test("local storage follows the same rules", async () => {
    const tcw = useLocalThreadStorage({ did: "did:test:local-rename" } as unknown as TinyCloudWeb);
    await appendMessage(tcw, "t1", user("m1", "First"));
    await setThreadTitle(tcw, "t1", "Mine");
    await appendMessage(tcw, "t1", user("m2", "Second"));
    expect((await getThread(tcw, "t1"))?.title).toBe("Mine");
    await setThreadTitle(tcw, "t1", "");
    expect((await getThread(tcw, "t1"))?.title).toBe("First");
  });
});

describe("normalizeUserTitle", () => {
  test("trims, collapses whitespace, caps length; whitespace-only is empty", () => {
    expect(normalizeUserTitle("  a \n b\t")).toBe("a b");
    expect(normalizeUserTitle(" \n\t ")).toBe("");
    expect(normalizeUserTitle("x".repeat(500))).toHaveLength(120);
  });
});
