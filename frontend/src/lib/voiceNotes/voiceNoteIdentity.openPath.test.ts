import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { FOREGROUND_QUIET_MS, inForeground, resetLanesForTests } from "../localFirst/requestLanes";
import { currentAccountGeneration, setAccountWorkPaused } from "./accountContext";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { createVoiceNotePipeline } from "./voiceNotePipeline";
import { ensureVoiceNoteIdentity, VOICE_NOTE_IDENTITY_VERSION } from "./voiceNoteRows";

// Option 8 (home-perf data §1a): the voice-note identity DDL and its
// sqlite_schema check ran on every open, among the Feed's first reads.

const IDENTITY_STATEMENT = /CREATE (TABLE|UNIQUE INDEX) IF NOT EXISTS|sqlite_schema|sqlite_master/i;
const SWEEP_STATEMENT = /SELECT DISTINCT source_id FROM connector_meeting WHERE source = 'exo-voice-note-dup'/;

let count = 0;
function space() {
  const sqlite = new Database(":memory:");
  const statements: string[] = [];
  const did = `did:test:identity-open-${++count}`;
  const sql = {
    db() {
      return {
        async query(statement: string, params: unknown[] = []) {
          statements.push(statement);
          try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
        async execute(statement: string, params: unknown[] = []) {
          statements.push(statement);
          try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
      };
    },
  };
  return { tcw: { did, spaceId: did, sql } as unknown as TinyCloudWeb, statements };
}

/** A later app open of the same account: a new SDK object, same space. */
function reopen(tcw: TinyCloudWeb): TinyCloudWeb {
  return { ...tcw } as TinyCloudWeb;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** Let the foreground go quiet on the fake clock. */
async function afterForegroundQuiet(): Promise<void> {
  await flush();
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS + 1);
  await flush();
}

const storage = new Map<string, string>();
const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const originalVoiceNotes = VoiceNotes;

beforeEach(() => {
  storage.clear();
  resetLanesForTests();
  jest.useFakeTimers();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  } });
  // An open with nothing recorded on this device.
  __setVoiceNotesForTests({ listPending: async () => ({ recordings: [] }) } as unknown as VoiceNotesPlugin, { available: true });
});

afterEach(() => {
  jest.useRealTimers();
  resetLanesForTests();
  __setVoiceNotesForTests(originalVoiceNotes, { available: null });
  if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
});

describe("voice-note identity on open", () => {
  test("the DDL and definition check run once per account per schema version, not on every open", async () => {
    const { tcw, statements } = space();
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    const firstOpen = statements.filter((sql) => IDENTITY_STATEMENT.test(sql));
    expect(firstOpen.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS voice_note_transcript"))).toBe(true);
    expect(firstOpen.some((sql) => sql.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS uq_connector_meeting_voice_note"))).toBe(true);
    expect(firstOpen.some((sql) => /sqlite_schema/.test(sql))).toBe(true);
    expect([...storage.keys()]).toEqual([`tinychat:voice-note-identity:${VOICE_NOTE_IDENTITY_VERSION}:${tcw.did}:${tcw.spaceId}`]);

    // A warm open: established from the marker with no schema statement.
    statements.length = 0;
    const warm = reopen(tcw);
    expect((await ensureVoiceNoteIdentity(warm)).status).toBe("established");
    await afterForegroundQuiet();
    expect(statements.filter((sql) => IDENTITY_STATEMENT.test(sql))).toEqual([]);

    // Another account on this device runs its own check once.
    const other = space();
    expect((await ensureVoiceNoteIdentity(other.tcw)).status).toBe("established");
    expect(other.statements.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS voice_note_transcript"))).toBe(true);
  });

  test("a warm open sweeps archived duplicates once, after the open's foreground reads", async () => {
    const { tcw, statements } = space();
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    statements.length = 0;

    let finishFirstPaint!: () => void;
    const firstPaintReads = inForeground(() => new Promise<void>((resolve) => { finishFirstPaint = resolve; }));
    const warm = reopen(tcw);
    expect((await ensureVoiceNoteIdentity(warm)).status).toBe("established");
    expect((await ensureVoiceNoteIdentity(warm)).status).toBe("established");
    await afterForegroundQuiet();
    expect(statements).toEqual([]);

    finishFirstPaint();
    await firstPaintReads;
    await afterForegroundQuiet();
    expect(statements.filter((sql) => SWEEP_STATEMENT.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => IDENTITY_STATEMENT.test(sql))).toEqual([]);
  });

  test("sign-out stops the post-open sweep, and the next identity check runs it again", async () => {
    const { tcw, statements } = space();
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    statements.length = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const warm = reopen(tcw);
    try {
      setAccountWorkPaused(warm, true);
      expect((await ensureVoiceNoteIdentity(warm)).status).toBe("established");
      await afterForegroundQuiet();
      expect(statements.filter((sql) => SWEEP_STATEMENT.test(sql))).toEqual([]);

      setAccountWorkPaused(warm, false);
      expect((await ensureVoiceNoteIdentity(warm)).status).toBe("established");
      await afterForegroundQuiet();
      expect(statements.filter((sql) => SWEEP_STATEMENT.test(sql))).toHaveLength(1);
      expect(statements.filter((sql) => IDENTITY_STATEMENT.test(sql))).toEqual([]);
    } finally {
      setAccountWorkPaused(warm, false);
      warn.mockRestore();
    }
  });

  test("an open with nothing to save runs the first identity check only after the open's foreground reads", async () => {
    const { tcw, statements } = space();
    let finishFirstPaint!: () => void;
    const firstPaintReads = inForeground(() => new Promise<void>((resolve) => { finishFirstPaint = resolve; }));

    const reconcile = createVoiceNotePipeline(tcw).reconcileAll({ did: tcw.did!, spaceId: tcw.spaceId!, generation: currentAccountGeneration() });
    await afterForegroundQuiet();
    expect(statements).toEqual([]);

    finishFirstPaint();
    await firstPaintReads;
    await afterForegroundQuiet();
    await reconcile;
    expect(statements.filter((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS voice_note_transcript"))).toHaveLength(1);

    // The next open of the same account issues no schema statement.
    statements.length = 0;
    const warm = reopen(tcw);
    const second = createVoiceNotePipeline(warm).reconcileAll({ did: warm.did!, spaceId: warm.spaceId!, generation: currentAccountGeneration() });
    await afterForegroundQuiet();
    await second;
    await afterForegroundQuiet();
    expect(statements.filter((sql) => IDENTITY_STATEMENT.test(sql))).toEqual([]);
  });
});
