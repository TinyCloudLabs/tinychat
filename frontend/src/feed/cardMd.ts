// card.md: the owner's one note on how cards are made for their Feed. The owner's copy lives in its own SQL database
// under the feed namespace, one row. Every connected agent gets a copy of that row in its own response database, which
// its feed token already reads, so a change reaches agents connected before it without a new grant; the CLI compares
// the version on publish. Only the owner writes either. The contract with the CLI is the table and `cardMdVersion`.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, type FeedDatabase } from "@tinycloud/sdk-services/feed";
import { hasLocalMarker, setLocalMarker } from "../lib/localFirst/localCache";
import { storageScopeFor, trackStorageWrites } from "../lib/storageStatus";
import { privateFeedDatabase } from "./privateFeedDatabase";
import { CARD_MD_DEFAULT } from "./cardMdDefault";
import { HOME_FEED_RESOURCE } from "./feedStore";

export const CARD_MD_RESOURCE = "xyz.tinycloud.tinychat/feed/card_md";
const FEED_PREFIX = "xyz.tinycloud.tinychat/feed";

/**
 * The same table in the owner's copy and in every agent's response database. One row, always id 1. No CHECK: the
 * node's SQL authorizer refuses a CHECK that reads a column.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS card_md (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
)`;
/** Writes only when the version differs, so a repeat (another device, a retry) changes nothing. */
const UPSERT = `INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET text = excluded.text, version = excluded.version, updated_at = excluded.updated_at
  WHERE card_md.version <> excluded.version`;

export interface CardMd { text: string; version: string; updatedAt: string }
/** A connected agent, as the owner's registry names it. */
export interface CardMdAgent { sourceId: string; responses: string }
export interface CardMdDelivery { sourceId: string; ok: boolean }

/** The first 12 hex of sha256 of the text: equal text, equal version, on every device and in the CLI. */
export function cardMdVersion(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 12);
}

function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "card.md storage failed");
  return result.data as T;
}

function upsert(db: FeedDatabase, record: CardMd) {
  return db.batch([{ sql: SCHEMA }, { sql: UPSERT, params: [record.text, record.version, record.updatedAt] }]);
}

/** The stored card.md, or null when the row is missing. A space without the table is an error: seed it first. */
export async function readCardMd(db: FeedDatabase): Promise<CardMd | null> {
  const row = unwrap(await db.query<string>("SELECT text, version, updated_at FROM card_md WHERE id = 1")).rows[0];
  if (!row) return null;
  const [text, version, updatedAt] = row;
  return { text: String(text), version: String(version), updatedAt: String(updatedAt) };
}

/** Saves the owner's text (empty is allowed: no instructions) and returns what is stored. */
export async function saveCardMd(db: FeedDatabase, text: string, now: Date = new Date()): Promise<CardMd> {
  unwrap(await upsert(db, { text, version: cardMdVersion(text), updatedAt: now.toISOString() }));
  return (await readCardMd(db))!;
}

/** Writes the default only where there is no card.md at all, so an owner's edit, or their clearing it, always stands. */
export async function seedCardMd(db: FeedDatabase, now: Date = new Date()): Promise<void> {
  unwrap(await db.batch([
    { sql: SCHEMA },
    { sql: "INSERT OR IGNORE INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)", params: [CARD_MD_DEFAULT, cardMdVersion(CARD_MD_DEFAULT), now.toISOString()] },
  ]));
}

/** The connected agents in the owner's registry. A row whose databases aren't the feed's own pair is skipped. */
export async function cardMdAgents(registry: FeedDatabase): Promise<CardMdAgent[]> {
  const rows = unwrap(await registry.query<unknown>("SELECT agent_id, output_resource, response_resource FROM feed_agents ORDER BY agent_id")).rows;
  return rows.flatMap(([id, output, responses]) => {
    if (typeof id !== "string" || typeof output !== "string" || typeof responses !== "string") return [];
    const names = feedResourceNames(FEED_PREFIX, output.slice(`${FEED_PREFIX}/feed_output_`.length));
    return names.ok && names.data.outputResource === output && names.data.responseResource === responses ? [{ sourceId: id, responses }] : [];
  });
}

/** Copies card.md into each agent's response database. Each agent's write stands alone: one failing doesn't stop the rest. */
export async function deliverCardMd(record: CardMd, agents: readonly CardMdAgent[], database: (resource: string) => FeedDatabase): Promise<CardMdDelivery[]> {
  const settled = await Promise.allSettled(agents.map(async (agent) => unwrap(await upsert(database(agent.responses), record))));
  return agents.map((agent, index) => ({ sourceId: agent.sourceId, ok: settled[index]!.status === "fulfilled" }));
}

function database(tcw: TinyCloudWeb, resource: string): FeedDatabase {
  return privateFeedDatabase(trackStorageWrites(tcw.sql.db(resource) as FeedDatabase, storageScopeFor(tcw)));
}

/** The signed-in owner's own copy of card.md. */
export function cardMdDatabase(tcw: TinyCloudWeb): FeedDatabase {
  return database(tcw, CARD_MD_RESOURCE);
}

const NO_SPACE = "card.md needs a signed-in TinyCloud space";

const seeded = new Map<string, Promise<void>>();

/** Seeds the default once per account on this device. A failed seed is forgotten, so the next call tries again. */
export function ensureCardMdSeeded(tcw: TinyCloudWeb): Promise<void> {
  const space = tcw.spaceId;
  if (!space) return Promise.reject(new Error(NO_SPACE));
  const marker = `tinychat:card-md-seeded:v1:${space}`;
  if (hasLocalMarker(marker)) return Promise.resolve();
  let pending = seeded.get(space);
  if (!pending) {
    pending = seedCardMd(cardMdDatabase(tcw)).then(
      () => setLocalMarker(marker),
      (error: unknown) => { seeded.delete(space); throw error; },
    );
    seeded.set(space, pending);
  }
  return pending;
}

/** Per account: the run in flight, and the one run queued behind it that every later call shares. */
const syncing = new Map<string, { running: Promise<CardMdDelivery[]>; next?: Promise<CardMdDelivery[]> }>();

async function syncOnce(tcw: TinyCloudWeb, space: string): Promise<CardMdDelivery[]> {
  await ensureCardMdSeeded(tcw);
  const record = await readCardMd(cardMdDatabase(tcw));
  if (!record) return [];
  const sent = (agent: CardMdAgent) => `tinychat:card-md-sent:${space}:${agent.sourceId}:${record.version}`;
  const due = (await cardMdAgents(database(tcw, HOME_FEED_RESOURCE))).filter((agent) => !hasLocalMarker(sent(agent)));
  const deliveries = await deliverCardMd(record, due, (resource) => database(tcw, resource));
  deliveries.forEach((delivery, index) => { if (delivery.ok) setLocalMarker(sent(due[index]!)); });
  return deliveries;
}

/**
 * Gives every connected agent the owner's current card.md, skipping agents this device already gave this version.
 * The Feed runs it when it opens and when it changes (a new agent gets it the first time the Feed sees it); Settings
 * runs it after a save. One run per account at a time: calls during a run share one more run after it.
 */
export function syncCardMd(tcw: TinyCloudWeb): Promise<CardMdDelivery[]> {
  const space = tcw.spaceId;
  if (!space) return Promise.reject(new Error(NO_SPACE));
  const start = (): Promise<CardMdDelivery[]> => {
    const running = syncOnce(tcw, space);
    syncing.set(space, { running });
    void running.catch(() => {}).finally(() => { if (syncing.get(space)?.running === running && !syncing.get(space)?.next) syncing.delete(space); });
    return running;
  };
  const current = syncing.get(space);
  if (!current) return start();
  current.next ??= current.running.catch(() => []).then(start);
  return current.next;
}
