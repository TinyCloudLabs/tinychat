// The reviewer seed: writes CONTENT (./content.ts) into one fresh, explicitly bound
// TinyCloud Home applications space through Home's own write paths, and reads it back
// through Home's own readers. It holds no key: the caller hands it a space handle that
// already carries the authority (see ./cli.ts). README.md is the contract.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, initializeFeedDatabases, publishFeedCard } from "@tinycloud/sdk-services/feed";
import { appendMessage, getThread, listThreads, setSetting } from "../../src/lib/threadStore";
import { THREADS_SQL_DB_NAME } from "../../src/lib/threadKeys";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "../../src/feed/feedStore";
import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "../../src/lib/connectors/connectorStore";
import { listMeetingsRead, readTranscript } from "../../src/lib/connectors/meetingExplorer";
import { commitVoiceNoteTranscript, createPastedTranscriptRow, ensureVoiceNoteIdentity, resolveVoiceNoteRow, transcriptRevKvPrefix } from "../../src/lib/voiceNotes/voiceNoteRows";
import { readTranscriptCommit } from "../../src/lib/voiceNotes/voiceNoteCommits";
import { VOICE_NOTE_SOURCE } from "../../src/lib/voiceNotes/voiceNoteStore";
import { pastedTranscriptCommit } from "../../src/capture/upload/pastedTranscript";
import { CHAT_THREAD_ID, chatMessages, FEED_AGENT, feedCards, SEED_MARKER_KEY, SEED_NAME, SEED_REVISION, VOICE_NOTE, voiceNoteStartedAt } from "./content";

/** What the seed touches on a space handle: Home's own `TinyCloudWeb` surface, nothing else. */
export type SeedSpace = Pick<TinyCloudWeb, "did" | "spaceId" | "sql" | "kv">;

export interface ReviewerSeedTarget {
  /** The applications space to seed, e.g. `tinycloud:pkh:eip155:1:0xabc…:applications`. */
  spaceId: string;
  /** The space owner's DID, e.g. `did:pkh:eip155:1:0xabc…`. */
  ownerDid: string;
  /** Owner DIDs the operator allows this run to seed. Never derived from the environment. */
  allowlist: readonly string[];
}

export type ReviewerSeedMode = { dryRun: true } | { dryRun: false; confirm: string | undefined };

export type RefusalCode =
  | "CONFIRMATION_REQUIRED" | "OWNER_NOT_ALLOWLISTED" | "TARGET_MISMATCH" | "NOT_FRESH" | "OTHER_REVISION" | "INSPECTION_FAILED";

export class ReviewerSeedRefusal extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
    this.name = "ReviewerSeedRefusal";
  }
}

export interface SeedMarker { seed: typeof SEED_NAME; revision: number; state: "in-progress" | "complete"; seededAt: string }

export interface PlannedWrite { surface: "settings" | "feed" | "chat" | "voice-note"; database: string; detail: string }

export interface ReviewerSeedReport {
  /** `planned`: dry run. `seeded`: a fresh space was seeded. `resumed`: an interrupted run of this revision finished. `already-seeded`: nothing to do. */
  status: "planned" | "seeded" | "resumed" | "already-seeded";
  seed: typeof SEED_NAME;
  revision: number;
  spaceId: string;
  ownerDid: string;
  seededAt: string;
  writes: PlannedWrite[];
}

/**
 * Rows found per table of the inspected databases. `seedRows` are rows a run of this revision
 * writes (by its fixed ids); everything else is someone else's. `settings` (preferences) is not counted.
 */
export interface SpaceInspection { marker: SeedMarker | null; occupied: { database: string; table: string; rows: number; seedRows: number }[] }

const FEED_PREFIX = "xyz.tinycloud.tinychat/feed";
const FEED_NAMES = unwrap(feedResourceNames(FEED_PREFIX, FEED_AGENT.token), "feed resource names");
/** Every database the seed writes, in the order the freshness check reads them. */
const INSPECTED_DATABASES = [THREADS_SQL_DB_NAME, HOME_FEED_RESOURCE, FEED_NAMES.outputResource, FEED_NAMES.responseResource, CONNECTORS_SQL_DB_NAME];
const SEED_CARD_ISSUANCES = feedCards(new Date(0).toISOString()).map((card) => card.issuanceId);
const SEED_MESSAGE_IDS = chatMessages(new Date(0).toISOString()).map((item) => item.message.id);
/**
 * The rows this revision writes, each matched by its own fixed id (`where`, constant SQL with
 * `params`), and at most `max` of them per table. A resumed run may find these and nothing else.
 */
const SEED_ROWS: Record<string, Record<string, { where: string; params: string[]; max: number }>> = {
  [THREADS_SQL_DB_NAME]: {
    threads: { where: "id = ?", params: [CHAT_THREAD_ID], max: 1 },
    messages: {
      where: `thread_id = ? AND json_extract(payload, '$.message.id') IN (${SEED_MESSAGE_IDS.map(() => "?").join(", ")})`,
      params: [CHAT_THREAD_ID, ...SEED_MESSAGE_IDS], max: SEED_MESSAGE_IDS.length,
    },
  },
  [HOME_FEED_RESOURCE]: { feed_agents: { where: "agent_id = ?", params: [FEED_AGENT.agentId], max: 1 } },
  [FEED_NAMES.outputResource]: {
    feed_cards: { where: `issuance_id IN (${SEED_CARD_ISSUANCES.map(() => "?").join(", ")})`, params: SEED_CARD_ISSUANCES, max: SEED_CARD_ISSUANCES.length },
  },
  [CONNECTORS_SQL_DB_NAME]: {
    connector_meeting: { where: "id = ?", params: [`vn-${VOICE_NOTE.sourceId}`], max: 1 },
    voice_note_transcript: { where: "source_id = ?", params: [VOICE_NOTE.sourceId], max: 1 },
  },
};

export interface SeedPermission { service: string; space: string; path: string; actions: string[] }

/**
 * Exactly what the seed and its read-back touch in the applications space: the capability
 * request the owner grants to the seed's one-run session key (see ./cli.ts). A dry run
 * only inspects, so it asks to read the databases the freshness check reads.
 */
export function seedPermissions(mode: ReviewerSeedMode): SeedPermission[] {
  if (mode.dryRun) return INSPECTED_DATABASES.map((path) => ({ service: "tinycloud.sql", space: "applications", path, actions: ["tinycloud.sql/read"] }));
  const kv = (path: string) => ({ service: "tinycloud.kv", space: "applications", path, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] });
  return [
    ...INSPECTED_DATABASES.map((path) => ({ service: "tinycloud.sql", space: "applications", path, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] })),
    kv(transcriptKvKey(VOICE_NOTE_SOURCE, VOICE_NOTE.sourceId)),
    kv(`${transcriptRevKvPrefix(VOICE_NOTE_SOURCE)}${VOICE_NOTE.sourceId}/`),
  ];
}

function unwrap<T>(result: { ok: boolean; data?: T; error?: { code?: string; message?: string } }, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error?.code ?? "ERROR"} ${result.error?.message ?? ""}`.trim());
  return result.data as T;
}

/** did:pkh:eip155:<chain>:<address> → its applications space id. Addresses compare case-insensitively. */
function applicationsSpaceOf(ownerDid: string): string | null {
  const match = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(ownerDid);
  return match ? `tinycloud:pkh:eip155:${match[1]}:${match[2]!.toLowerCase()}:applications` : null;
}

/** The checks that need no storage: allowlist, owner/space binding and confirmation. Run before any request. */
export function assertSeedTarget(space: Pick<SeedSpace, "did" | "spaceId">, target: ReviewerSeedTarget, mode: ReviewerSeedMode): void {
  const sameDid = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!target.allowlist.some((allowed) => sameDid(allowed, target.ownerDid)))
    throw new ReviewerSeedRefusal("OWNER_NOT_ALLOWLISTED", `Owner ${target.ownerDid} is not on the operator's allowlist`);
  const expected = applicationsSpaceOf(target.ownerDid);
  if (!expected || expected !== target.spaceId.replace(/0x[0-9a-fA-F]{40}/, (address) => address.toLowerCase()))
    throw new ReviewerSeedRefusal("TARGET_MISMATCH", `Space ${target.spaceId} is not the applications space of ${target.ownerDid}`);
  if (space.spaceId !== target.spaceId || typeof space.did !== "string" || !sameDid(space.did, target.ownerDid))
    throw new ReviewerSeedRefusal("TARGET_MISMATCH", "The authorized space handle is not bound to the requested owner and space");
  if (!mode.dryRun && mode.confirm !== target.spaceId)
    throw new ReviewerSeedRefusal("CONFIRMATION_REQUIRED", "Writing needs --confirm set to the exact target space id (or use --dry-run)");
}

function parseMarker(raw: unknown): SeedMarker | "foreign" {
  try {
    const marker = JSON.parse(String(raw)) as Partial<SeedMarker>;
    if (marker.seed === SEED_NAME && Number.isInteger(marker.revision) && (marker.state === "in-progress" || marker.state === "complete")
      && typeof marker.seededAt === "string" && Number.isFinite(Date.parse(marker.seededAt))) return marker as SeedMarker;
  } catch { /* unreadable: treated as foreign */ }
  return "foreign";
}

/**
 * Read-only: lists the tables of every database the seed writes, counts their rows (and how
 * many of them are this revision's own), and reads the seed marker. Never creates a table
 * (Home's own readers do, so they are not used here). A database that does not exist yet
 * lists no tables. Any read that fails or returns an unexpected shape refuses the run.
 */
export async function inspectSpace(space: SeedSpace): Promise<SpaceInspection> {
  const occupied: SpaceInspection["occupied"] = [];
  let marker: SeedMarker | null = null;
  for (const database of INSPECTED_DATABASES) {
    const db = space.sql.db(database);
    const read = async (sql: string, params: string[] = []) => {
      const result = await db.query(sql, params);
      if (!result.ok) throw new ReviewerSeedRefusal("INSPECTION_FAILED", `Could not read ${database}: ${result.error.code} ${result.error.message}`);
      return result.data.rows as unknown[][];
    };
    const count = async (table: string, where = "", params: string[] = []) => {
      const [row] = await read(`SELECT COUNT(*) FROM "${table.replaceAll('"', '""')}"${where}`, params);
      const rows = Number(row?.[0]);
      if (!Number.isSafeInteger(rows) || rows < 0) throw new ReviewerSeedRefusal("INSPECTION_FAILED", `Could not count ${database}.${table}`);
      return rows;
    };
    const tables = (await read("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
      .map((row) => String(row[0]));
    for (const table of tables) {
      if (database === THREADS_SQL_DB_NAME && table === "settings") {
        const stored = await read("SELECT value FROM settings WHERE key = ?", [SEED_MARKER_KEY]);
        if (stored.length) {
          const parsed = parseMarker(stored[0]![0]);
          if (parsed === "foreign") throw new ReviewerSeedRefusal("OTHER_REVISION", `The space holds an unreadable ${SEED_MARKER_KEY} marker`);
          marker = parsed;
        }
        continue;
      }
      const rows = await count(table);
      if (rows === 0) continue;
      const own = SEED_ROWS[database]?.[table];
      const seedRows = own ? Math.min(own.max, await count(table, ` WHERE ${own.where}`, own.params)) : 0;
      occupied.push({ database, table, rows, seedRows });
    }
  }
  return { marker, occupied };
}

/** Every write the seed makes, in order. The same list is the dry-run output. */
export function planSeed(seededAt: string): PlannedWrite[] {
  return [
    { surface: "settings", database: THREADS_SQL_DB_NAME, detail: `setSetting ${SEED_MARKER_KEY} = revision ${SEED_REVISION}, in-progress (creates Home's threads tables)` },
    { surface: "feed", database: HOME_FEED_RESOURCE, detail: "createHomeFeedSource().load() (creates Home's Feed registry tables)" },
    { surface: "feed", database: `${FEED_NAMES.outputResource}, ${FEED_NAMES.responseResource}`, detail: "initializeFeedDatabases" },
    ...feedCards(seededAt).map((card): PlannedWrite => ({
      surface: "feed", database: FEED_NAMES.outputResource, detail: `publishFeedCard ${card.cardId} r${card.revision} "${card.title}"` })),
    { surface: "feed", database: HOME_FEED_RESOURCE, detail: `register agent ${FEED_AGENT.agentId} ("${FEED_AGENT.label}") in feed_agents` },
    ...chatMessages(seededAt).map((item): PlannedWrite => ({
      surface: "chat", database: THREADS_SQL_DB_NAME, detail: `appendMessage ${CHAT_THREAD_ID} ${item.message.role} ${item.message.id}` })),
    { surface: "voice-note", database: CONNECTORS_SQL_DB_NAME, detail: "ensureVoiceNoteIdentity (creates Home's connectors tables)" },
    { surface: "voice-note", database: CONNECTORS_SQL_DB_NAME, detail: `createPastedTranscriptRow ${VOICE_NOTE.sourceId} "${VOICE_NOTE.title}" (+ KV transcript placeholder)` },
    { surface: "voice-note", database: CONNECTORS_SQL_DB_NAME, detail: `commitVoiceNoteTranscript ${VOICE_NOTE.sourceId} rev 1 (+ KV transcript-rev body)` },
    { surface: "settings", database: THREADS_SQL_DB_NAME, detail: `setSetting ${SEED_MARKER_KEY} = revision ${SEED_REVISION}, complete` },
  ];
}

async function writeMarker(space: SeedSpace, state: SeedMarker["state"], seededAt: string): Promise<void> {
  const marker: SeedMarker = { seed: SEED_NAME, revision: SEED_REVISION, state, seededAt };
  await setSetting(space as TinyCloudWeb, SEED_MARKER_KEY, JSON.stringify(marker));
}

/** Each step is idempotent for this revision's fixed ids and `seededAt`, so an interrupted run resumes. */
async function applySeed(space: SeedSpace, seededAt: string): Promise<void> {
  const tcw = space as TinyCloudWeb;
  await writeMarker(space, "in-progress", seededAt);

  // Feed: Home's reader creates its registry; the agent's databases and cards go through the Feed SDK.
  // The agent row is written last, so Home never lists an agent whose cards are not there yet.
  await createHomeFeedSource(tcw).load();
  const output = space.sql.db(FEED_NAMES.outputResource);
  unwrap(await initializeFeedDatabases({ output, responses: space.sql.db(FEED_NAMES.responseResource) }), "initializeFeedDatabases");
  for (const card of feedCards(seededAt)) unwrap(await publishFeedCard(output, card), `publishFeedCard ${card.cardId}`);
  unwrap(await space.sql.db(HOME_FEED_RESOURCE).execute(
    `INSERT INTO feed_agents (agent_id, agent_did, label, output_resource, response_resource, authorization_json)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO NOTHING`,
    [FEED_AGENT.agentId, space.did, FEED_AGENT.label, FEED_NAMES.outputResource, FEED_NAMES.responseResource,
      JSON.stringify({ seed: SEED_NAME, revision: SEED_REVISION })],
  ), "register feed agent");

  // Chat: the runtime's own append; the message id makes a repeated append a no-op.
  for (const item of chatMessages(seededAt)) await appendMessage(tcw, CHAT_THREAD_ID, item);

  // Voice note: the Library's paste path (row + committed transcript), without audio.
  const identity = await ensureVoiceNoteIdentity(tcw);
  if (identity.status !== "established") throw new Error(`Voice-note storage is not ready: ${identity.status} ${identity.reason ?? ""}`.trim());
  if (!await resolveVoiceNoteRow(tcw, VOICE_NOTE.sourceId))
    await createPastedTranscriptRow(tcw, VOICE_NOTE.sourceId, VOICE_NOTE.title, voiceNoteStartedAt(seededAt));
  await commitVoiceNoteTranscript(tcw, VOICE_NOTE.sourceId, pastedTranscriptCommit(VOICE_NOTE.transcript));

  await writeMarker(space, "complete", seededAt);
}

/**
 * Seeds `space` once. Refuses (ReviewerSeedRefusal) before any write unless the owner is
 * allowlisted, the handle is bound to that owner's applications space, the run is
 * confirmed (or a dry run), and the space is fresh, or holds only this revision's own rows
 * under its in-progress marker (an interrupted run).
 */
export async function runReviewerSeed(space: SeedSpace, target: ReviewerSeedTarget, mode: ReviewerSeedMode,
  now: () => Date = () => new Date()): Promise<ReviewerSeedReport> {
  assertSeedTarget(space, target, mode);
  const { marker, occupied } = await inspectSpace(space);
  if (marker && marker.revision !== SEED_REVISION)
    throw new ReviewerSeedRefusal("OTHER_REVISION", `The space was seeded at revision ${marker.revision}; this is revision ${SEED_REVISION}. Wipe the space, then run again.`);
  const foreign = marker ? occupied.filter((o) => o.rows > o.seedRows) : occupied;
  if (marker?.state !== "complete" && foreign.length)
    throw new ReviewerSeedRefusal("NOT_FRESH", `The space is not fresh: ${foreign.map((o) => `${o.database}.${o.table} has ${o.rows - (marker ? o.seedRows : 0)} row(s) the seed did not write`).join("; ")}`);

  const seededAt = marker?.seededAt ?? now().toISOString();
  const report = (status: ReviewerSeedReport["status"], writes: PlannedWrite[]): ReviewerSeedReport =>
    ({ status, seed: SEED_NAME, revision: SEED_REVISION, spaceId: target.spaceId, ownerDid: target.ownerDid, seededAt, writes });
  if (marker?.state === "complete") return report("already-seeded", []);
  if (mode.dryRun) return report("planned", planSeed(seededAt));
  await applySeed(space, seededAt);
  return report(marker ? "resumed" : "seeded", planSeed(seededAt));
}

export interface SeedReadback { chats: { id: string; title: string; messages: number }[]; feedCards: string[]; voiceNotes: { sourceId: string; title: string | null; transcriptSegments: number }[] }

/** What Home's own readers show for the seeded items: the thread list, the Feed, and the Library. */
export async function readBackSeed(space: SeedSpace): Promise<SeedReadback> {
  const tcw = space as TinyCloudWeb;
  const summaries = await listThreads(tcw);
  const chats = [];
  for (const summary of summaries.filter((s) => s.id === CHAT_THREAD_ID)) {
    const doc = await getThread(tcw, summary.id);
    chats.push({ id: summary.id, title: summary.title, messages: doc?.messages.length ?? 0 });
  }
  const feed = await createHomeFeedSource(tcw).load();
  const library = await listMeetingsRead(tcw, [VOICE_NOTE_SOURCE]);
  if (library.status !== "ok") throw new Error("The Library could not list voice notes");
  const voiceNotes = [];
  for (const meeting of library.meetings.filter((m) => m.sourceId === VOICE_NOTE.sourceId)) {
    const commit = await readTranscriptCommit(tcw, meeting.sourceId);
    const transcript = commit ? await readTranscript(tcw, VOICE_NOTE_SOURCE, meeting.sourceId, commit.bodyKey) : null;
    voiceNotes.push({ sourceId: meeting.sourceId, title: meeting.title, transcriptSegments: transcript?.status === "ok" ? transcript.sentences.length : 0 });
  }
  return {
    chats,
    feedCards: feed.entries.filter((entry) => entry.source.sourceId === FEED_AGENT.agentId).map((entry) => entry.state.card.cardId).sort(),
    voiceNotes,
  };
}
