// card.md: the owner's one note on how cards are made for their Feed. The owner's master copy is one row (table
// `card_md`) in the owner-only `threads` database: the signed-in session holds it, and neither an `onboard --with feed`
// grant nor an agent token covers it. Every connected agent gets a copy of that row in its own response database, which
// its feed token already reads, so a change reaches agents connected before it without a new grant; the CLI compares
// the version on publish. Only the owner writes the master; the copies sit under the feed namespace, so each run
// repairs any that differ. The contract with the CLI is the per-agent table and `cardMdVersion`.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, type FeedDatabase } from "@tinycloud/sdk-services/feed";
import { hasLocalMarker, setLocalMarker } from "../lib/localFirst/localCache";
import { storageScopeFor, trackStorageWrites } from "../lib/storageStatus";
import { privateFeedDatabase } from "./privateFeedDatabase";
import { CARD_MD_DEFAULT } from "./cardMdDefault";
import { HOME_FEED_RESOURCE } from "./feedStore";
import { THREADS_SQL_DB_NAME } from "../lib/threadKeys";

/** The owner's master lives in the owner-only threads database, table `card_md`. */
const CARD_MD_DATABASE = THREADS_SQL_DB_NAME;
/** Where the master lived before: the feed namespace, which `onboard --with feed` grants can write. */
const LEGACY_CARD_MD_RESOURCE = "xyz.tinycloud.tinychat/feed/card_md";
const FEED_PREFIX = "xyz.tinycloud.tinychat/feed";

/**
 * The same table in the owner's copy and in every agent's response database. One row, always id 1. No CHECK: the
 * node's SQL authorizer refuses a CHECK that reads a column.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS card_md (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
)`;
/**
 * Writes when the text or the version differs, so a repeat (another device, a retry) changes nothing. Both are compared:
 * the version is a stored string, so text altered under the same version must still be replaced.
 */
const UPSERT = `INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET text = excluded.text, version = excluded.version, updated_at = excluded.updated_at
  WHERE card_md.text <> excluded.text OR card_md.version <> excluded.version`;

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

const TABLE_PROBE = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_md'";
const INSERT_IF_MISSING = "INSERT OR IGNORE INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)";

/**
 * One-time move of the owner's card.md from the feed namespace (`LEGACY_CARD_MD_RESOURCE`) to the master table.
 * Where the master has no row: an old row is copied over with its text as it is, its version recomputed from that text
 * so the agent copies stay consistent. When the old row's version did not match its text, a warning says so and the
 * text is carried over. Only where there is no table and no row is the default seeded. The copy is INSERT OR
 * IGNORE, so an owner's edit made after it always stands, and a second run changes nothing. Then the old row is
 * deleted, so it stops being a writable source anyone trusts.
 *
 * The version is not a check on the text: anyone can compute a sha256 prefix, so a row rewritten before this ran
 * carries over like any other. The owner sees the carried-over text in Settings and can change it. An owner who
 * cleared their card.md (empty text, its own version) keeps it cleared.
 *
 * The old row is the owner's only copy until the master holds it, so after the insert the master is read back: a row
 * there lets the old row be deleted and the move count as finished (true). No row there (the insert reported success
 * but nothing is stored) leaves the old row alone, logs nothing and returns false, so the caller does not mark the
 * move done and the next run tries again. A failure throws before the old row is deleted, for the same retry.
 */
export async function migrateCardMd(master: FeedDatabase, legacy: FeedDatabase, now: Date = new Date()): Promise<boolean> {
  unwrap(await master.batch([{ sql: SCHEMA }]));
  const legacyTable = unwrap(await legacy.query<string>(TABLE_PROBE)).rows.length > 0;
  let stored = await readCardMd(master);
  if (!stored) {
    const old = legacyTable ? await readCardMd(legacy) : null;
    if (old) {
      if (old.version !== cardMdVersion(old.text)) console.warn("card.md migration: the old row's version did not match its text, and the text was carried over as it is");
      unwrap(await master.execute(INSERT_IF_MISSING, [old.text, cardMdVersion(old.text), old.updatedAt]));
    } else {
      unwrap(await master.execute(INSERT_IF_MISSING, [CARD_MD_DEFAULT, cardMdVersion(CARD_MD_DEFAULT), now.toISOString()]));
    }
    stored = await readCardMd(master);
  }
  if (!stored) return false;
  if (legacyTable) unwrap(await legacy.execute("DELETE FROM card_md WHERE id = 1"));
  return true;
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

/** Whether the agent's stored copy is exactly the master. A copy that cannot be read counts as not matching. */
async function copyMatches(db: FeedDatabase, record: CardMd): Promise<boolean> {
  try {
    const copy = await readCardMd(db);
    return copy !== null && copy.text === record.text && copy.version === record.version;
  } catch { return false; }
}

/**
 * Brings each agent's response database to the master: reads the agent's copy and writes only when its text or version
 * differs. The version alone is not enough: it is a stored string, so a copy with other text and the master's version
 * would pass for current. Each agent's read and write stand alone: one failing doesn't stop the rest.
 */
export async function deliverCardMd(record: CardMd, agents: readonly CardMdAgent[], database: (resource: string) => FeedDatabase): Promise<CardMdDelivery[]> {
  const settled = await Promise.allSettled(agents.map(async (agent) => {
    const db = database(agent.responses);
    if (await copyMatches(db, record)) return;
    unwrap(await upsert(db, record));
  }));
  return agents.map((agent, index) => ({ sourceId: agent.sourceId, ok: settled[index]!.status === "fulfilled" }));
}

function database(tcw: TinyCloudWeb, resource: string): FeedDatabase {
  return privateFeedDatabase(trackStorageWrites(tcw.sql.db(resource) as FeedDatabase, storageScopeFor(tcw)));
}

/** The signed-in owner's master card.md: table `card_md` in the owner-only threads database. */
export function cardMdDatabase(tcw: TinyCloudWeb): FeedDatabase {
  return database(tcw, CARD_MD_DATABASE);
}

/** Where the master lived before: the feed namespace. Read and cleared by the one-time migration only. */
function legacyCardMdDatabase(tcw: TinyCloudWeb): FeedDatabase {
  return database(tcw, LEGACY_CARD_MD_RESOURCE);
}

const NO_SPACE = "card.md needs a signed-in TinyCloud space";

const seeded = new Map<string, Promise<void>>();

/**
 * Moves the owner's card.md to the master location once per account on this device (`migrateCardMd`). The marker is
 * set only when the move finished; a failed or unfinished run is forgotten, so the next call tries again. The marker
 * is new on purpose: a device that seeded under the old location still has to migrate.
 */
export function ensureCardMdSeeded(tcw: TinyCloudWeb): Promise<void> {
  const space = tcw.spaceId;
  if (!space) return Promise.reject(new Error(NO_SPACE));
  const marker = `tinychat:card-md-threads:v1:${space}`;
  if (hasLocalMarker(marker)) return Promise.resolve();
  let pending = seeded.get(space);
  if (!pending) {
    pending = migrateCardMd(cardMdDatabase(tcw), legacyCardMdDatabase(tcw)).then(
      (finished) => { if (finished) setLocalMarker(marker); else seeded.delete(space); },
      (error: unknown) => { seeded.delete(space); throw error; },
    );
    seeded.set(space, pending);
  }
  return pending;
}

/** Per account: the run in flight, and the one run queued behind it that every later call shares. */
const syncing = new Map<string, { running: Promise<CardMdDelivery[]>; next?: Promise<CardMdDelivery[]> }>();

async function syncOnce(tcw: TinyCloudWeb): Promise<CardMdDelivery[]> {
  await ensureCardMdSeeded(tcw);
  const record = await readCardMd(cardMdDatabase(tcw));
  if (!record) return [];
  const agents = await cardMdAgents(database(tcw, HOME_FEED_RESOURCE));
  return deliverCardMd(record, agents, (resource) => database(tcw, resource));
}

/**
 * Gives every connected agent the owner's current card.md and repairs any copy that differs from it. Every run reads
 * each agent's copy (no per-device "already sent" shortcut: a copy can be changed behind this device's back) and
 * writes only the ones that differ. The Feed runs it when it opens and when it changes (a new agent gets it the first
 * time the Feed sees it); Settings runs it after a save. One run per account at a time: calls during a run share one
 * more run after it.
 */
export function syncCardMd(tcw: TinyCloudWeb): Promise<CardMdDelivery[]> {
  const space = tcw.spaceId;
  if (!space) return Promise.reject(new Error(NO_SPACE));
  const start = (): Promise<CardMdDelivery[]> => {
    const running = syncOnce(tcw);
    syncing.set(space, { running });
    void running.catch(() => {}).finally(() => { if (syncing.get(space)?.running === running && !syncing.get(space)?.next) syncing.delete(space); });
    return running;
  };
  const current = syncing.get(space);
  if (!current) return start();
  current.next ??= current.running.catch(() => []).then(start);
  return current.next;
}
