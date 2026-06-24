import { describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  clearMemory,
  getMemory,
  memoryWriteGen,
  resetMemoryToTemplate,
  setMemory,
} from "./threadStore";
import { MEMORY_TEMPLATE } from "./memory";

/** Capture console.warn output for the duration of `fn` (restores after). */
async function captureWarn(fn: () => Promise<void>): Promise<string> {
  const orig = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return calls.join("\n");
}

// These ids are the stable row keys defined in threadStore.ts (not exported).
const LIVE = "user_context";
const BACKUP = "user_context_backup";

type SqlError = { code: string; message: string };
type SqlResult = { ok: true; data: { rows: unknown[][] } } | { ok: false; error: SqlError };

/**
 * Minimal in-memory stand-in for `tcw.sql.db(...)`. Interprets only the SQL the
 * memory helpers issue (SELECT/UPSERT/DELETE on the `memory` table + the schema
 * CREATEs) by substring match, so we can assert the backup/restore/clear
 * behavior without a real node. `queryError`, when set, fails every SELECT (used
 * to exercise the prior-read-failed and AUTH_UNAUTHORIZED paths).
 */
class FakeSqlDb {
  rows = new Map<string, string>();
  queryError: SqlError | null = null;

  query(sql: string, params: unknown[] = []): SqlResult {
    if (this.queryError && /select\s+content\s+from\s+memory/i.test(sql)) {
      return { ok: false, error: this.queryError };
    }
    if (/select\s+content\s+from\s+memory\s+where\s+id/i.test(sql)) {
      const id = String(params[0]);
      return this.rows.has(id)
        ? { ok: true, data: { rows: [[this.rows.get(id)!]] } }
        : { ok: true, data: { rows: [] } };
    }
    return { ok: true, data: { rows: [] } };
  }

  private apply(sql: string, params: unknown[] = []): void {
    if (/create\s+table/i.test(sql)) return;
    if (/insert\s+into\s+memory/i.test(sql)) {
      this.rows.set(String(params[0]), String(params[1]));
    } else if (/delete\s+from\s+memory/i.test(sql)) {
      this.rows.delete(String(params[0]));
    }
  }

  execute(sql: string, params: unknown[] = []): SqlResult {
    this.apply(sql, params);
    return { ok: true, data: { rows: [] } };
  }

  batch(stmts: { sql: string; params?: unknown[] }[]): SqlResult {
    for (const s of stmts) this.apply(s.sql, s.params ?? []);
    return { ok: true, data: { rows: [] } };
  }
}

// tcw with no did/spaceId → the localStorage cache is disabled deterministically
// (memoryCacheKey returns null) and ensureSchema is never memoized, so every
// call exercises the fake fresh. SQL always routes through our FakeSqlDb.
function makeTcw(db: FakeSqlDb): TinyCloudWeb {
  return { did: undefined, spaceId: undefined, sql: { db: () => db } } as unknown as TinyCloudWeb;
}

describe("threadStore memory backup/restore (Layer 3)", () => {
  it("setMemory snapshots the prior live doc into the backup row before overwriting", async () => {
    const db = new FakeSqlDb();
    db.rows.set(LIVE, "OLD DOC");

    await setMemory(makeTcw(db), "NEW DOC");

    expect(db.rows.get(LIVE)).toBe("NEW DOC");
    expect(db.rows.get(BACKUP)).toBe("OLD DOC");
  });

  it("setMemory writes only the live row when there is no prior doc to back up", async () => {
    const db = new FakeSqlDb();

    await setMemory(makeTcw(db), "FIRST DOC");

    expect(db.rows.get(LIVE)).toBe("FIRST DOC");
    expect(db.rows.has(BACKUP)).toBe(false);
  });

  it("setMemory skips the backup (and warns) when the prior-doc read fails, still writing live", async () => {
    const db = new FakeSqlDb();
    db.rows.set(LIVE, "OLD DOC");
    db.queryError = { code: "DB_ERR", message: "boom" }; // fails the prior SELECT only
    const logged = await captureWarn(() => setMemory(makeTcw(db), "NEW DOC"));

    expect(db.rows.get(LIVE)).toBe("NEW DOC"); // primary write still lands
    expect(db.rows.has(BACKUP)).toBe(false); // backup skipped, not silently
    expect(logged).toContain("prior-doc read failed");
  });

  it("getMemory returns the live doc when present", async () => {
    const db = new FakeSqlDb();
    db.rows.set(LIVE, "LIVE DOC");

    expect(await getMemory(makeTcw(db))).toBe("LIVE DOC");
  });

  it("getMemory auto-restores from the backup row when the live row is empty/missing", async () => {
    const db = new FakeSqlDb();
    db.rows.set(BACKUP, "BACKUP DOC"); // backup present, live absent

    const restored = await getMemory(makeTcw(db));

    expect(restored).toBe("BACKUP DOC");
    expect(db.rows.get(LIVE)).toBe("BACKUP DOC"); // restored into live
  });

  it("getMemory returns null when neither live nor backup exists", async () => {
    expect(await getMemory(makeTcw(new FakeSqlDb()))).toBeNull();
  });

  it("getMemory falls back gracefully (no throw, returns null) on AUTH_UNAUTHORIZED", async () => {
    const db = new FakeSqlDb();
    db.rows.set(LIVE, "DOC");
    db.queryError = { code: "AUTH_UNAUTHORIZED", message: "no capability" };
    let result: string | null = "unset";
    const logged = await captureWarn(async () => {
      result = await getMemory(makeTcw(db));
    });

    expect(result).toBeNull(); // cache disabled → null, never throws
    expect(logged).toContain("unauthorized");
  });

  it("clearMemory deletes BOTH the live and backup rows (Clear is not resurrected)", async () => {
    const db = new FakeSqlDb();
    db.rows.set(LIVE, "DOC");
    db.rows.set(BACKUP, "OLD DOC");

    await clearMemory(makeTcw(db));

    expect(db.rows.has(LIVE)).toBe(false);
    expect(db.rows.has(BACKUP)).toBe(false);
  });

  it("resetMemoryToTemplate writes the scaffold to the live row and returns it", async () => {
    const db = new FakeSqlDb();
    const written = await resetMemoryToTemplate(makeTcw(db));

    expect(written).toBe(MEMORY_TEMPLATE);
    expect(db.rows.get(LIVE)).toBe(MEMORY_TEMPLATE);
  });

  it("resetMemoryToTemplate snapshots the prior live doc into the backup row", async () => {
    const db = new FakeSqlDb();
    db.rows.set(LIVE, "PRIOR USER NOTES");

    await resetMemoryToTemplate(makeTcw(db));

    expect(db.rows.get(LIVE)).toBe(MEMORY_TEMPLATE);
    // Prior doc is preserved as last-known-good so the user can still surface
    // it (via getMemory's auto-restore) if the reset turns out to be a mistake.
    expect(db.rows.get(BACKUP)).toBe("PRIOR USER NOTES");
  });

  it("resetMemoryToTemplate bumps memoryWriteGen (so in-flight reads can drop their stale ref writes)", async () => {
    const db = new FakeSqlDb();
    const before = memoryWriteGen();

    await resetMemoryToTemplate(makeTcw(db));

    expect(memoryWriteGen()).toBeGreaterThan(before);
  });

  it("resetMemoryToTemplate refreshes the localStorage cache to the scaffold", async () => {
    // Stand up a minimal localStorage shim and bind a tcw with a did so the
    // memoryCacheKey path is exercised (and we can read back what was cached).
    const storage = new Map<string, string>();
    const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
      clear: () => {
        storage.clear();
      },
      key: () => null,
      length: 0,
    } as Storage;
    (globalThis as { window?: { localStorage: Storage } }).window = {
      localStorage: (globalThis as { localStorage: Storage }).localStorage,
    };

    try {
      const db = new FakeSqlDb();
      db.rows.set(LIVE, "OLD DOC");
      const tcw = {
        did: "did:pkh:test:reset",
        spaceId: undefined,
        sql: { db: () => db },
      } as unknown as TinyCloudWeb;

      await resetMemoryToTemplate(tcw);

      expect(storage.get("tinychat:memory:did:pkh:test:reset")).toBe(MEMORY_TEMPLATE);
    } finally {
      if (originalLocalStorage) {
        (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      }
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
