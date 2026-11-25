import { randomUUID } from "node:crypto";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { TINYCLOUD_FIND_MEETINGS, TINYCLOUD_LIST_MEETING_ACTIONS, TINYCLOUD_READ_MEETING, TINYCLOUD_SEARCH_TRANSCRIPTS } from "../mcp-meetings/tools.js";
import { isFeedChatTool } from "./feed-chat.js";
import type { OwnerDid, StandingArea } from "./standing-types.js";

export type ReadOutcome = "ok" | "off" | "no_grant" | "not_owner" | "expired" | "revoked" | "budget" | "busy" | "not_found" | "unavailable" | "error";

export interface ReadAuditAttempt {
  at: string;
  owner: OwnerDid;
  area: StandingArea;
  tool: string;
}

export interface ReadAudit {
  /** Commits the attempt before the tool can read. A write failure refuses the read. */
  begin(a: ReadAuditAttempt): Promise<string>;
  settle(id: string, outcome: ReadOutcome): Promise<void>;
  summary(owner: OwnerDid, fromIso: string, toIso: string): Promise<ReadSummary>;
}

export interface ReadSummary {
  owner: OwnerDid;
  from: string;
  to: string;
  days: { day: string; area: StandingArea; tool: string; ok: number; refused: number }[];
  total: number;
}

/** Read-attempt rows, in the backend's own space. A key root: listed in BACKEND_KV_ROOTS. */
export const TRUSTBOT_READ_AUDIT_KEY_PREFIX = "trustbot/read-audit/";
const OWNER_DID = /^did:pkh:eip155:1:0x[0-9a-f]{40}$/;
const KEY = /^trustbot\/read-audit\/(did:pkh:eip155:1:0x[0-9a-f]{40})\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\/[0-9a-f-]{36}$/;
const RETENTION_MS = 90 * 86_400_000;
const PAGE_SIZE = 100;
const OUTCOMES = new Set<ReadOutcome>([
  "ok", "off", "no_grant", "not_owner", "expired", "revoked", "budget", "busy", "not_found", "unavailable", "error",
]);

/** The meeting tools TrustBot may run, by the names the gateway serves them under. */
export const TRUSTBOT_MEETING_TOOLS = [
  TINYCLOUD_FIND_MEETINGS, TINYCLOUD_READ_MEETING, TINYCLOUD_SEARCH_TRANSCRIPTS, TINYCLOUD_LIST_MEETING_ACTIONS,
] as const;

export function readAuditArea(tool: string): StandingArea | undefined {
  if (isFeedChatTool(tool)) return "feed_chats";
  if (TRUSTBOT_MEETING_TOOLS.some(name => name === tool)) return "meetings";
}

type AuditRow = Pick<ReadAuditAttempt, "area" | "tool"> & { outcome: ReadOutcome | "pending" };

function timestamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) throw new Error("read_audit_invalid_time");
  return new Date(time).toISOString();
}

function parseRow(value: string): AuditRow {
  const saved = JSON.parse(value) as Partial<AuditRow> | null;
  if (!saved || typeof saved.tool !== "string" || saved.area === undefined || readAuditArea(saved.tool) !== saved.area ||
    saved.outcome === undefined || (saved.outcome !== "pending" && !OUTCOMES.has(saved.outcome))) {
    throw new Error("read_audit_invalid_row");
  }
  return { area: saved.area, tool: saved.tool, outcome: saved.outcome };
}

function keyParts(key: string) {
  const match = KEY.exec(key);
  if (!match || !match[3]!.startsWith(match[2]!)) return undefined;
  return { owner: match[1]!, day: match[2]!, at: match[3]! };
}

async function* auditPages(node: TinyCloudNode, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await withSessionRefresh(node, async () => assertKvResult(await node.kv.list({ prefix, cursor, limit: PAGE_SIZE })));
    if (!page.ok || (page.data.truncated && !page.data.nextCursor) || (cursor && cursor === page.data.nextCursor)) {
      throw new Error("read_audit_listing_unavailable");
    }
    yield page.data.keys;
    cursor = page.data.nextCursor;
  } while (cursor);
}

export function createReadAudit(node: TinyCloudNode, now = Date.now): ReadAudit {
  return {
    async begin({ owner, at, area, tool }) {
      if (!OWNER_DID.test(owner) || readAuditArea(tool) !== area) throw new Error("read_audit_invalid_attempt");
      const time = timestamp(at);
      const id = `${TRUSTBOT_READ_AUDIT_KEY_PREFIX}${owner}/${time.slice(0, 10)}/${time}/${randomUUID()}`;
      const value: AuditRow = { area, tool, outcome: "pending" };
      const stored = await withSessionRefresh(node, async () =>
        assertKvResult(await node.kv.put(id, JSON.stringify(value), { ifNoneMatch: "*" })));
      if (!stored.ok) throw new Error("read_audit_write_unavailable");
      return id;
    },
    async settle(id, outcome) {
      if (!keyParts(id) || !OUTCOMES.has(outcome)) throw new Error("read_audit_invalid_settlement");
      await withSessionRefresh(node, async () => {
        const stored = assertKvResult(await node.kv.get<string>(id, { raw: true }));
        if (!stored.ok) throw new Error("read_audit_settlement_unavailable");
        const current = parseRow(stored.data.data);
        if (current.outcome === outcome) return;
        const ifMatch = stored.data.headers.etag;
        if (current.outcome !== "pending" || !ifMatch) throw new Error("read_audit_settlement_unavailable");
        assertKvResult(await node.kv.put(id, JSON.stringify({ ...current, outcome }), { ifMatch }));
      });
    },
    async summary(owner, fromIso, toIso) {
      if (!OWNER_DID.test(owner)) throw new Error("read_audit_invalid_owner");
      const from = timestamp(fromIso);
      const to = timestamp(toIso);
      if (from > to) throw new Error("read_audit_invalid_range");
      const retainedFrom = new Date(now() - RETENTION_MS).toISOString();
      const start = from < retainedFrom ? retainedFrom : from;
      if (start >= to) return { owner, from: fromIso, to: toIso, days: [], total: 0 };
      const byDay = new Map<string, ReadSummary["days"][number]>();
      let total = 0;
      for await (const page of auditPages(node, `${TRUSTBOT_READ_AUDIT_KEY_PREFIX}${owner}/`)) {
        const keys = page.filter(key => {
          const parts = keyParts(key);
          return parts?.owner === owner && parts.at >= start && parts.at < to;
        });
        if (keys.length === 0) continue;
        const batch = await withSessionRefresh(node, async () => assertKvResult(await node.kv.batchGet<string>(keys, { raw: true })));
        if (!batch.ok) throw new Error("read_audit_summary_unavailable");
        for (const { key, result } of batch.data.results) {
          const parts = keyParts(key);
          if (!parts || parts.owner !== owner || parts.at < start || parts.at >= to || isKvMissingKeyResult(result, key)) continue;
          assertKvResult(result);
          if (!result.ok) throw new Error("read_audit_summary_unavailable");
          const { area, tool, outcome } = parseRow(result.data.data);
          const day = parts.day;
          const group = `${day}/${area}/${tool}`;
          let counts = byDay.get(group);
          if (!counts) {
            counts = { day, area, tool, ok: 0, refused: 0 };
            byDay.set(group, counts);
          }
          // An interrupted attempt remains visible and is counted as refused.
          if (outcome === "ok") counts.ok++;
          else counts.refused++;
          total++;
        }
      }
      const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, counts]) => counts);
      return { owner, from: fromIso, to: toIso, days, total };
    },
  };
}

/** Remove attempts older than 90 days, including interrupted attempts. */
export async function purgeReadAudit(node: TinyCloudNode, now = Date.now()): Promise<void> {
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  for await (const page of auditPages(node, TRUSTBOT_READ_AUDIT_KEY_PREFIX)) {
    for (const key of page) {
      const parts = keyParts(key);
      if (!parts || parts.at >= cutoff) continue;
      await withSessionRefresh(node, async () => {
        const result = await node.kv.delete(key);
        if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
      });
    }
  }
}

/** The backend's audit store and its retention sweep, including when standing access is off. */
export class RetainedReadAudit {
  readonly store: ReadAudit;

  constructor(node: TinyCloudNode) {
    this.store = createReadAudit(node);
    let purging = false;
    const sweep = () => {
      if (purging) return;
      purging = true;
      void purgeReadAudit(node).catch(() => {}).finally(() => { purging = false; });
    };
    sweep();
    setInterval(sweep, 60 * 60_000).unref();
  }
}
