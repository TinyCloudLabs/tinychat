// The board's open inventory, mirrored into Home in one process (TC-2204). Cards are built from roci-board's local
// index (~/.local/state/rocinante-sitrep/board-index.sqlite), so building the plan reads nothing from the node.
// Each card's UUID is derived from its board key, so a re-run names the same cards and the mirror's own idempotency
// keeps it from posting twice. Holds and claims stay on the board. `closeFromBoard` is the way back: a mirrored card
// whose board record has closed is closed in Home too.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { feedCardSchema } from "@tinycloud/sdk-services/feed";
import type { FeedCard } from "@tinycloud/sdk-services/feed";
import {
  boardKey, effectivePriority, emptySitrepOwnerData, findRecordSecrets, isClosed, isKind, parseSitrepCardPayload, projectSitrepCard, validateRecord,
} from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorBindings, homeMirrorDiagnostic, homeMirrorPublicationSha256, homeMirrorRecord, homeMirrorRefusal, publishHomeMirror, publishHomeMirrorClosing, readHomeMirrorHeld, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorContext, HomeMirrorPublishInput } from "./bridge-types";

export const INVENTORY_KINDS = ["ask", "task", "incident", "progress", "work", "approval"] as const satisfies readonly Kind[];
export type InventoryKind = (typeof INVENTORY_KINDS)[number];
const STAYS_ON_BOARD: readonly Kind[] = ["hold", "claim"];

/** Namespace of the board-key UUIDs (RFC 4122 v5). Changing it renames every mirrored card. */
const BOARD_KEY_NAMESPACE = "3f0b6f1e-2a54-5a8c-9d3e-7c1b2a4d6e80";

export function uuidV5(name: string, namespace: string = BOARD_KEY_NAMESPACE): string {
  const space = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (space.length !== 16) throw new Error("Invalid UUID namespace");
  const bytes = createHash("sha1").update(space).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A board card's Home identity: the same for its key on every run. */
export function boardCardIdentity(fullKey: string): { cardId: string; revision: 1; issuanceId: string } {
  return { cardId: uuidV5(fullKey), revision: 1, issuanceId: uuidV5(`${fullKey}#revision-1`) };
}

export interface InventoryRow { key: string; record: BoardRecord }
export type InventorySkipReason = "unreadable" | "key-mismatch" | "closed" | "bound-elsewhere" | "flagged";
/** `detail` is set for "flagged" only: the card's id and the kinds of finding, never a value. */
export interface InventorySkip { key: string; reason: InventorySkipReason; detail?: string }

export function parseInventoryKinds(value: string | undefined): InventoryKind[] {
  if (value === undefined) return [...INVENTORY_KINDS];
  const kinds = value.split(",").map((kind) => kind.trim()).filter(Boolean);
  if (!kinds.length || kinds.some((kind) => STAYS_ON_BOARD.includes(kind as Kind))) throw homeMirrorRefusal("Home mirror inventory leaves holds and claims on the board");
  if (kinds.some((kind) => !(INVENTORY_KINDS as readonly string[]).includes(kind))) throw homeMirrorRefusal("Home mirror inventory requires a board index, a source and full spaces");
  return [...new Set(kinds)] as InventoryKind[];
}

type IndexRecord = { record: BoardRecord; cardUuid: unknown } | { reason: "unreadable" | "key-mismatch" };
/** One index row as a record, with the card UUID a copy the mirror already wrote carries beside it (bridge.ts `publication`). */
function indexRecord(key: string, kind: unknown, id: unknown, json: unknown): IndexRecord {
  if (typeof kind !== "string" || !isKind(kind) || typeof id !== "string" || typeof json !== "string") return { reason: "unreadable" };
  let value: unknown;
  try { value = JSON.parse(json); } catch { return { reason: "unreadable" }; }
  let cardUuid: unknown;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "cardUuid")) {
    const { cardUuid: carried, ...rest } = value as Record<string, unknown>;
    cardUuid = carried; value = rest;
  }
  const checked = validateRecord(kind, value);
  if (!checked.ok) return { reason: "unreadable" };
  if (key !== boardKey(kind, id) || checked.value.id !== id) return { reason: "key-mismatch" };
  return { record: checked.value, cardUuid };
}
function openIndex(path: string): Database {
  try { return new Database(path, { readonly: true }); } catch { throw homeMirrorRefusal("Board index is unreadable"); }
}

/** The index's open records of `kinds`, oldest first. One local read; no node call. */
export function readBoardIndex(path: string, kinds: readonly InventoryKind[]): { rows: InventoryRow[]; skipped: InventorySkip[] } {
  const database = openIndex(path);
  try {
    let raw: unknown[][];
    try {
      raw = database.query(`SELECT key,kind,id,record_json FROM records WHERE closed=0 AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created_ms,key`).values(...kinds) as unknown[][];
    } catch { throw homeMirrorRefusal("Board index is unreadable"); }
    const rows: InventoryRow[] = [], skipped: InventorySkip[] = [];
    for (const [key, kind, id, json] of raw) {
      if (typeof key !== "string") continue;
      const read = indexRecord(key, kind, id, json);
      if ("reason" in read) { skipped.push({ key, reason: read.reason }); continue; }
      if (isClosed(read.record)) { skipped.push({ key, reason: "closed" }); continue; }
      if (read.cardUuid !== undefined && read.cardUuid !== boardCardIdentity(key).cardId) { skipped.push({ key, reason: "bound-elsewhere" }); continue; }
      rows.push({ key, record: read.record });
    }
    return { rows, skipped };
  } finally { database.close(); }
}

/**
 * The index's closed records among `keys` (the board keys the mirror has bound), oldest first. One local read; no node
 * call. A key whose record is not closed in the index, or does not read, is left out.
 */
export function readClosedBoardRows(path: string, keys: readonly string[]): { rows: InventoryRow[]; skipped: InventorySkip[] } {
  const database = openIndex(path);
  try {
    const rows: InventoryRow[] = [], skipped: InventorySkip[] = [];
    for (let at = 0; at < keys.length; at += 500) {
      const chunk = keys.slice(at, at + 500);
      let raw: unknown[][];
      try {
        raw = database.query(`SELECT key,kind,id,record_json FROM records WHERE closed=1 AND key IN (${chunk.map(() => "?").join(",")}) ORDER BY created_ms,key`).values(...chunk) as unknown[][];
      } catch { throw homeMirrorRefusal("Board index is unreadable"); }
      for (const [key, kind, id, json] of raw) {
        if (typeof key !== "string") continue;
        const read = indexRecord(key, kind, id, json);
        if ("reason" in read) { skipped.push({ key, reason: read.reason }); continue; }
        if (!isClosed(read.record)) continue;
        if (read.cardUuid !== undefined && read.cardUuid !== boardCardIdentity(key).cardId) { skipped.push({ key, reason: "bound-elsewhere" }); continue; }
        rows.push({ key, record: read.record });
      }
    }
    return { rows, skipped };
  } finally { database.close(); }
}

/**
 * The Home card for one board record, as the import builds it (prepare-import.ts), under its board-key identity.
 * Holds and claims are refused here as well as at the command line: they stay on the board.
 */
export function boardCard(row: InventoryRow, all: readonly BoardRecord[], now: number): FeedCard {
  const { record } = row;
  if (STAYS_ON_BOARD.includes(record.kind)) throw homeMirrorRefusal("Home mirror inventory leaves holds and claims on the board");
  const carried = homeMirrorRecord(record, now);
  const projection = projectSitrepCard(record, all, emptySitrepOwnerData(), now);
  const card: FeedCard = {
    ...boardCardIdentity(row.key), kind: record.kind, needsResponse: projection.request,
    title: record.title, body: record.body ?? "",
    ...(record.kind === "ask" ? { choices: record.options.map((option) => ({ id: option.id, label: option.label })) } : {}),
    urgency: effectivePriority(record).urgency, createdAt: record.createdAt,
    payload: { sitrep: { version: 1, record: carried }, source: { label: "Rocinante board", ref: row.key }, ...(record.repo ? { project: record.repo } : {}), ...(carried.post ? { summary: carried.post } : {}) },
  };
  const typed = parseSitrepCardPayload(card.payload?.sitrep);
  if (!feedCardSchema.safeParse(card).success || !typed || !isDeepStrictEqual(typed.record, carried)) throw homeMirrorRefusal("Home mirror operation refused");
  return card;
}

export interface InventoryPlanItem { key: string; kind: Kind; id: string; cardId: string; issuanceId: string; needsResponse: boolean }

/** The board key of a card the mirror refused for what it holds, or a placeholder when its id is itself what was flagged (the key carries the id). */
const refusedKey = (row: InventoryRow): string => findRecordSecrets(row.record.kind, { id: row.record.id }).length ? "(key withheld)" : row.key;

/** The plan for a dry run: what would be posted, and what is left out and why. */
export function inventoryPlan(rows: readonly InventoryRow[], now: number): { items: InventoryPlanItem[]; refused: InventorySkip[] } {
  const all = rows.map((row) => row.record), items: InventoryPlanItem[] = [], refused: InventorySkip[] = [];
  for (const row of rows) {
    try {
      const card = boardCard(row, all, now);
      items.push({ key: row.key, kind: row.record.kind, id: row.record.id, cardId: card.cardId, issuanceId: card.issuanceId, needsResponse: card.needsResponse });
    } catch (error) {
      const { detail } = homeMirrorDiagnostic(error).error;
      refused.push(detail === undefined ? { key: row.key, reason: "unreadable" } : { key: refusedKey(row), reason: "flagged", detail });
    }
  }
  return { items, refused };
}

export type PostManyOutcome = "posted" | "already" | "changed" | "refused";
export interface PostManyItem { key: string; cardId: string; outcome: PostManyOutcome; code?: string; detail?: string }

/**
 * Posts each row through the mirror, one after another, reading the registry and the mirror table once for the
 * whole run. A card already mirrored with the same content costs no node call; one whose board record changed since
 * it was mirrored is reported, not re-posted (that needs a new revision).
 */
export async function postMany(ctx: HomeMirrorContext, options: { sourceId: string; label: string; rows: readonly InventoryRow[]; now: number }): Promise<PostManyItem[]> {
  const run: HomeMirrorContext = { ...ctx, cache: ctx.cache ?? {} };
  const source = await readHomeMirrorSource(run, options.sourceId);
  const mirrored = await knownBindings(run);
  const all = options.rows.map((row) => row.record), results: PostManyItem[] = [];
  for (const row of options.rows) {
    if (run.signal?.aborted) break;
    let card: FeedCard;
    try { card = boardCard(row, all, options.now); } catch (error) {
      const { detail } = homeMirrorDiagnostic(error).error;
      results.push({ key: detail === undefined ? row.key : refusedKey(row), cardId: boardCardIdentity(row.key).cardId, outcome: "refused", code: "INVALID_INPUT", ...(detail === undefined ? {} : { detail }) });
      continue;
    }
    const known = mirrored(row.key);
    if (known) {
      const same = known.cardId === card.cardId && known.publicationSha256 === homeMirrorPublicationSha256(row.record, card.cardId);
      results.push({ key: row.key, cardId: card.cardId, outcome: same ? "already" : "changed" });
      continue;
    }
    const input: HomeMirrorPublishInput = { source: { ...source, label: options.label }, card, legacy: { spaceId: run.legacySpaceId, fullKey: row.key, record: row.record } };
    try {
      await publishHomeMirror(run, input);
      results.push({ key: row.key, cardId: card.cardId, outcome: "posted" });
    } catch (error) {
      const { code, detail } = homeMirrorDiagnostic(error).error;
      results.push({ key: row.key, cardId: card.cardId, outcome: "refused", code, ...(detail === undefined ? {} : { detail }) });
    }
  }
  return results;
}

/** Board keys already bound, from the run's cached mirror table (read once per run). */
async function knownBindings(ctx: HomeMirrorContext): Promise<(key: string) => { cardId: string; publicationSha256: string } | undefined> {
  const bindings = await homeMirrorBindings(ctx);
  const byKey = new Map(bindings.map((binding) => [binding.legacy.fullKey, { cardId: binding.cardUuid, publicationSha256: binding.legacy.publicationSha256 }]));
  return (key) => byKey.get(key);
}

export type CloseFromBoardOutcome = "closed" | "already" | "not-mirrored" | "still-open" | "answered-in-home" | "refused";
export interface CloseFromBoardItem { key: string; kind: Kind; cardId: string; outcome: CloseFromBoardOutcome; code?: string; detail?: string }

/**
 * The closing revision of a mirrored card: the next revision after `held`, built from the record as it is now (closed),
 * no longer waiting on the owner. Its issuance is derived from the board key and the revision, so a retry cannot post a
 * second one. A closed approval carries no consent code, and a record the secret guard flags is refused, as in a post.
 */
export function closingCard(row: InventoryRow, all: readonly BoardRecord[], held: FeedCard, now: number): FeedCard {
  const built = boardCard(row, all, now);
  if (built.cardId !== held.cardId) throw homeMirrorRefusal("Home mirror operation refused");
  const revision = held.revision + 1;
  return { ...built, revision, issuanceId: uuidV5(`${row.key}#revision-${revision}`), needsResponse: false };
}

/**
 * Closes in Home each mirrored card whose board record has closed (the way back of `postMany`: an answer on the
 * board's own page never reaches the mirror, and the card would wait on the owner until it expired). One outcome per
 * row. A card the owner answered in Home is left as it is: that answer closes the board record, and the card is
 * already answered. With `dryRun` nothing is written, and "closed" means "would close".
 */
export async function closeFromBoard(ctx: HomeMirrorContext, options: { sourceId: string; rows: readonly InventoryRow[]; now: number; dryRun?: boolean }): Promise<CloseFromBoardItem[]> {
  const run: HomeMirrorContext = { ...ctx, cache: ctx.cache ?? {} };
  await homeMirrorBindings(run);
  const all = options.rows.map((row) => row.record), results: CloseFromBoardItem[] = [];
  for (const row of options.rows) {
    if (run.signal?.aborted) break;
    const item = (outcome: CloseFromBoardOutcome, extra: { code?: string; detail?: string } = {}): CloseFromBoardItem => ({ key: row.key, kind: row.record.kind, cardId: boardCardIdentity(row.key).cardId, outcome, ...extra });
    if (!isClosed(row.record)) { results.push(item("still-open")); continue; }
    try {
      const held = await readHomeMirrorHeld(run, options.sourceId, row.key);
      if (!held) { results.push(item("not-mirrored")); continue; }
      if (!held.card.needsResponse) { results.push(item("already")); continue; }
      if (held.answered) { results.push(item("answered-in-home")); continue; }
      const card = closingCard(row, all, held.card, options.now);
      if (options.dryRun !== true) await publishHomeMirrorClosing(run, held, card);
      results.push(item("closed"));
    } catch (error) {
      const { code, detail } = homeMirrorDiagnostic(error).error;
      // As in a post: a record whose id is itself what was flagged is named by neither its id nor its board key.
      results.push({ ...item("refused", { code, ...(detail === undefined ? {} : { detail }) }), key: detail === undefined ? row.key : refusedKey(row) });
    }
  }
  return results;
}
