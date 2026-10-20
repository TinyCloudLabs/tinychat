// TC-1152 S2c-1: a fake signed-in space that can be combined in, for the Combine screens and tests.
// Fake data only: no account, no network. Unlike libraryTcw (a read-only fixture) this one keeps state: it
// answers the exact statements the Library list, the note reads and combinedMeetingStore issue, and it
// applies INSERT / UPDATE / DELETE, so a combine or a delete shows up in the next list read.
//
// `log` records every SQL statement and KV call in order (tests assert "nothing was written before the tap").
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";

import { harnessTcw } from "../stubs";

export interface SpaceRow {
  id: string;
  source: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  durationSecs: number | null;
  /** The stored `participants` column (JSON text). */
  participants?: string;
  /** The stored `metadata` column, verbatim (a test may make it garbage). */
  metadata?: string;
  /** The stored transcript body, verbatim (JSON text). */
  body?: string;
  /** The stored `summary_overview` / `summary_action_items` columns of a combined meeting. */
  summaryOverview?: string | null;
  summaryActionItems?: string | null;
}

export interface SpaceCall { kind: "sql" | "kv"; method: string; text: string; write: boolean }

export interface CombineSpace {
  tcw: TinyCloudWeb;
  /** Rows by id, as stored. */
  rows: Map<string, SpaceRow>;
  /** KV values by key. */
  kv: Map<string, string>;
  log: SpaceCall[];
  /** `fail` makes the next call matching it fail (a write that does not land). */
  failNext: { sql: RegExp | null; kv: "put" | "delete" | "get" | null };
  /** Per-call delay (ms) for KV gets, so a loading state can be seen. */
  getDelayMs: number;
}

const bodyKey = (source: string, sourceId: string) => `${CONNECTORS_KV_PREFIX}/${source}/transcript/${sourceId}`;

export function combineSpace(seed: readonly SpaceRow[], options: { did?: string } = {}): CombineSpace {
  const rows = new Map<string, SpaceRow>();
  const kv = new Map<string, string>();
  const space: CombineSpace = { tcw: undefined as unknown as TinyCloudWeb, rows, kv, log: [], failNext: { sql: null, kv: null }, getDelayMs: 0 };
  for (const r of seed) {
    rows.set(r.id, { ...r });
    if (r.body !== undefined) kv.set(bodyKey(r.source, r.sourceId), r.body);
  }
  const ok = (data: unknown) => ({ ok: true, data });
  const fail = (code: string) => ({ ok: false, error: { code, message: "harness: failed" } });

  const run = async (method: "query" | "execute", statement: string, params: unknown[] = []) => {
    const s = statement.replace(/\s+/g, " ").trim();
    const write = /^(INSERT|UPDATE|DELETE)/i.test(s);
    space.log.push({ kind: "sql", method, text: s, write });
    if (write && space.failNext.sql?.test(s)) { space.failNext.sql = null; return fail("SQL_ERROR"); }
    if (s.includes("FROM sqlite_schema")) return ok({ rows: [] });
    if (s.includes("+c.source IN")) {
      const sources = new Set(params as string[]);
      const listed = [...rows.values()].filter((r) => sources.has(r.source)).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      return ok({ rows: listed.map((r) => [r.id, r.source, r.sourceId, r.title, r.startedAt, r.durationSecs, null, null]) });
    }
    if (s === "SELECT metadata FROM connector_meeting WHERE id = ?") {
      const r = rows.get(String(params[0]));
      return ok({ rows: r ? [[r.metadata ?? "{}"]] : [] });
    }
    if (s.startsWith("SELECT title, started_at, duration_secs, participants, metadata FROM connector_meeting WHERE source = ? AND source_id = ?")) {
      const r = [...rows.values()].find((x) => x.source === params[0] && x.sourceId === params[1]);
      return ok({ rows: r ? [[r.title, r.startedAt, r.durationSecs, r.participants ?? "[]", r.metadata ?? "{}"]] : [] });
    }
    if (s.startsWith("SELECT id FROM connector_meeting WHERE source = 'exo-merged' AND source_id = ?")) {
      return ok({ rows: [...rows.values()].filter((r) => r.source === "exo-merged" && r.sourceId === params[0]).map((r) => [r.id]).sort() });
    }
    if (s === "SELECT source_id FROM connector_meeting WHERE id = ? AND source = 'exo-merged'") {
      const r = rows.get(String(params[0]));
      return ok({ rows: r && r.source === "exo-merged" ? [[r.sourceId]] : [] });
    }
    if (s === "SELECT source_id, metadata FROM connector_meeting WHERE id = ? AND source = 'exo-merged'") {
      const r = rows.get(String(params[0]));
      return ok({ rows: r && r.source === "exo-merged" ? [[r.sourceId, r.metadata ?? null]] : [] });
    }
    if (s === "SELECT id, source_id, metadata FROM connector_meeting WHERE source = 'exo-merged'") {
      return ok({ rows: [...rows.values()].filter((r) => r.source === "exo-merged").map((r) => [r.id, r.sourceId, r.metadata ?? null]) });
    }
    if (s === "SELECT source_id, summary_overview, summary_action_items FROM connector_meeting WHERE id = ? AND source = 'exo-merged'") {
      const r = rows.get(String(params[0]));
      return ok({ rows: r && r.source === "exo-merged" ? [[r.sourceId, r.summaryOverview ?? null, r.summaryActionItems ?? null]] : [] });
    }
    if (s === "UPDATE connector_meeting SET summary_overview = ?, summary_action_items = ? WHERE id = ? AND source = 'exo-merged'") {
      const [overview, actionItems, id] = params as (string | null)[];
      const r = rows.get(String(id));
      if (r && r.source === "exo-merged") rows.set(r.id, { ...r, summaryOverview: overview, summaryActionItems: actionItems });
      return ok({ rows: [] });
    }
    if (s.startsWith("INSERT INTO connector_meeting")) {
      const [id, source, sourceId, title, startedAt, durationSecs, , participants, , , , , metadata] = params as (string | number | null)[];
      if (rows.has(String(id))) return fail("SQL_CONSTRAINT");
      rows.set(String(id), { id: String(id), source: String(source), sourceId: String(sourceId), title: title as string | null, startedAt: startedAt as string | null, durationSecs: durationSecs as number | null, participants: String(participants), metadata: String(metadata) });
      return ok({ rows: [] });
    }
    if (s.startsWith("UPDATE connector_meeting SET title = ?") && s.endsWith("WHERE id = ? AND source = 'exo-merged'")) {
      const [title, startedAt, durationSecs, participants, metadata, , id] = params as (string | number | null)[];
      const r = rows.get(String(id));
      if (r && r.source === "exo-merged") rows.set(r.id, { ...r, title: title as string | null, startedAt: startedAt as string | null, durationSecs: durationSecs as number | null, participants: String(participants), metadata: String(metadata) });
      return ok({ rows: [] });
    }
    if (s === "DELETE FROM connector_meeting WHERE id = ? AND source = 'exo-merged'") {
      const r = rows.get(String(params[0]));
      if (r && r.source === "exo-merged") rows.delete(r.id);
      return ok({ rows: [] });
    }
    // Other reads the shell makes (voice-note previews, pipelines) find nothing; an unknown WRITE is a bug in the test.
    if (write) throw new Error(`combineSpace: unexpected write: ${s}`);
    return ok({ rows: [] });
  };

  const keyOf = (key: string) => key;
  const kvApi = {
    get: async (key: string) => {
      space.log.push({ kind: "kv", method: "get", text: key, write: false });
      if (space.getDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, space.getDelayMs));
      if (space.failNext.kv === "get") { space.failNext.kv = null; return fail("KV_ERROR"); }
      const value = kv.get(keyOf(key));
      return value === undefined ? { ok: false, error: { code: "KV_NOT_FOUND", message: "harness: nothing stored" } } : ok({ data: value, headers: {} });
    },
    put: async (key: string, value: unknown) => {
      space.log.push({ kind: "kv", method: "put", text: key, write: true });
      if (space.failNext.kv === "put") { space.failNext.kv = null; return fail("KV_ERROR"); }
      kv.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return ok({ headers: {} });
    },
    delete: async (key: string) => {
      space.log.push({ kind: "kv", method: "delete", text: key, write: true });
      if (space.failNext.kv === "delete") { space.failNext.kv = null; return fail("KV_ERROR"); }
      kv.delete(key);
      return ok({ headers: {} });
    },
  };
  const sqlApi = { db: () => ({ query: (st: string, p?: unknown[]) => run("query", st, p), execute: (st: string, p?: unknown[]) => run("execute", st, p) }) };
  const kvProxy = new Proxy(kvApi as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : (harnessTcw.kv as unknown as Record<string | symbol, unknown>)[key]),
  });
  space.tcw = new Proxy(harnessTcw, {
    get: (target, key) => (key === "sql" ? sqlApi : key === "kv" ? kvProxy : key === "spaceId" ? "harness-combine" : key === "did" ? (options.did ?? "did:test:combine") : Reflect.get(target, key)),
  }) as TinyCloudWeb;
  return space;
}
