// The board's open inventory, mirrored into Home in one process (TC-2204). Cards are built from roci-board's local
// index (~/.local/state/rocinante-sitrep/board-index.sqlite), so building the plan reads nothing from the node.
// Each card's UUID is derived from its board key, so a re-run names the same cards and the mirror's own idempotency
// keeps it from posting twice. Approvals, holds and claims stay on the board.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { feedCardSchema } from "@tinycloud/sdk-services/feed";
import type { FeedCard } from "@tinycloud/sdk-services/feed";
import {
  boardKey, effectivePriority, emptySitrepOwnerData, isClosed, isKind, parseSitrepCardPayload, projectSitrepCard, validateRecord,
} from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorBindings, homeMirrorDiagnostic, homeMirrorPublicationSha256, homeMirrorRefusal, publishHomeMirror, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorContext, HomeMirrorPublishInput } from "./bridge-types";

export const INVENTORY_KINDS = ["ask", "task", "incident", "progress", "work"] as const satisfies readonly Kind[];
export type InventoryKind = (typeof INVENTORY_KINDS)[number];
const STAYS_ON_BOARD: readonly Kind[] = ["approval", "hold", "claim"];

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
export type InventorySkipReason = "unreadable" | "key-mismatch" | "closed" | "bound-elsewhere";
export interface InventorySkip { key: string; reason: InventorySkipReason }

export function parseInventoryKinds(value: string | undefined): InventoryKind[] {
  if (value === undefined) return [...INVENTORY_KINDS];
  const kinds = value.split(",").map((kind) => kind.trim()).filter(Boolean);
  if (!kinds.length || kinds.some((kind) => STAYS_ON_BOARD.includes(kind as Kind))) throw homeMirrorRefusal("Home mirror inventory leaves approvals, holds and claims on the board");
  if (kinds.some((kind) => !(INVENTORY_KINDS as readonly string[]).includes(kind))) throw homeMirrorRefusal("Home mirror inventory requires a board index, a source and full spaces");
  return [...new Set(kinds)] as InventoryKind[];
}

/** The index's open records of `kinds`, oldest first. One local read; no node call. */
export function readBoardIndex(path: string, kinds: readonly InventoryKind[]): { rows: InventoryRow[]; skipped: InventorySkip[] } {
  let database: Database;
  try { database = new Database(path, { readonly: true }); } catch { throw homeMirrorRefusal("Board index is unreadable"); }
  try {
    let raw: unknown[][];
    try {
      raw = database.query(`SELECT key,kind,id,record_json FROM records WHERE closed=0 AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created_ms,key`).values(...kinds) as unknown[][];
    } catch { throw homeMirrorRefusal("Board index is unreadable"); }
    const rows: InventoryRow[] = [], skipped: InventorySkip[] = [];
    for (const [key, kind, id, json] of raw) {
      if (typeof key !== "string") continue;
      if (typeof kind !== "string" || !isKind(kind) || typeof id !== "string" || typeof json !== "string") { skipped.push({ key, reason: "unreadable" }); continue; }
      let value: unknown;
      try { value = JSON.parse(json); } catch { skipped.push({ key, reason: "unreadable" }); continue; }
      // A copy the mirror already wrote carries its card UUID beside the record (bridge.ts `publication`).
      let cardUuid: unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "cardUuid")) {
        const { cardUuid: carried, ...rest } = value as Record<string, unknown>;
        cardUuid = carried; value = rest;
      }
      const checked = validateRecord(kind, value);
      if (!checked.ok) { skipped.push({ key, reason: "unreadable" }); continue; }
      if (key !== boardKey(kind, id) || checked.value.id !== id) { skipped.push({ key, reason: "key-mismatch" }); continue; }
      if (isClosed(checked.value)) { skipped.push({ key, reason: "closed" }); continue; }
      if (cardUuid !== undefined && cardUuid !== boardCardIdentity(key).cardId) { skipped.push({ key, reason: "bound-elsewhere" }); continue; }
      rows.push({ key, record: checked.value });
    }
    return { rows, skipped };
  } finally { database.close(); }
}

/** The Home card for one board record, as the import builds it (prepare-import.ts), under its board-key identity. */
export function boardCard(row: InventoryRow, all: readonly BoardRecord[], now: number): FeedCard {
  const { record } = row;
  const projection = projectSitrepCard(record, all, emptySitrepOwnerData(), now);
  const card: FeedCard = {
    ...boardCardIdentity(row.key), kind: record.kind, needsResponse: projection.request,
    title: record.title, body: record.body ?? "",
    ...(record.kind === "ask" ? { choices: record.options.map((option) => ({ id: option.id, label: option.label })) } : {}),
    urgency: effectivePriority(record).urgency, createdAt: record.createdAt,
    payload: { sitrep: { version: 1, record }, source: { label: "Rocinante board", ref: row.key }, ...(record.repo ? { project: record.repo } : {}) },
  };
  const typed = parseSitrepCardPayload(card.payload?.sitrep);
  if (!feedCardSchema.safeParse(card).success || !typed || !isDeepStrictEqual(typed.record, record)) throw homeMirrorRefusal("Home mirror operation refused");
  return card;
}

export interface InventoryPlanItem { key: string; kind: Kind; id: string; cardId: string; issuanceId: string; needsResponse: boolean }

/** The plan for a dry run: what would be posted, and what is left out and why. */
export function inventoryPlan(rows: readonly InventoryRow[], now: number): { items: InventoryPlanItem[]; refused: InventorySkip[] } {
  const all = rows.map((row) => row.record), items: InventoryPlanItem[] = [], refused: InventorySkip[] = [];
  for (const row of rows) {
    try {
      const card = boardCard(row, all, now);
      items.push({ key: row.key, kind: row.record.kind, id: row.record.id, cardId: card.cardId, issuanceId: card.issuanceId, needsResponse: card.needsResponse });
    } catch { refused.push({ key: row.key, reason: "unreadable" }); }
  }
  return { items, refused };
}

export type PostManyOutcome = "posted" | "already" | "changed" | "refused";
export interface PostManyItem { key: string; cardId: string; outcome: PostManyOutcome; code?: string }

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
    try { card = boardCard(row, all, options.now); } catch { results.push({ key: row.key, cardId: boardCardIdentity(row.key).cardId, outcome: "refused", code: "INVALID_INPUT" }); continue; }
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
      results.push({ key: row.key, cardId: card.cardId, outcome: "refused", code: homeMirrorDiagnostic(error).error.code });
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
