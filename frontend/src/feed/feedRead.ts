import {
  feedCardSchema,
  feedResponsePayloadSchema,
  newFeedMessageSchema,
  newFeedResponseSchema,
  projectFeedResponseNotification,
  type FeedCard,
  type FeedCardIdentity,
  type FeedCardState,
  type FeedHandling,
  type FeedReadDatabase,
  type FeedResponse,
  type FeedResponseHandling,
  type FeedResponseIdentity,
  type FeedResponsePayload,
} from "@tinycloud/sdk-services/feed";

/**
 * The Feed's reads, one statement per database. A single SELECT reads one
 * SQLite snapshot, so each statement also returns the freshness tally of the
 * tables it read, taken from that same snapshot: the load knows exactly which
 * writes it holds, whenever it ran relative to the live-update stream.
 *
 * The rows are parsed as the SDK's own reads parse them (`listFeedCards`,
 * `listFeedCardHistory`, `listFeedResponses`, `readFeedResponsePayload`,
 * `readFeedResponseHandling`, `getFeedCardState`), which the SDK cannot
 * combine into one request.
 */

function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Home feed storage failed");
  return result.data as T;
}

/** `count:highest rowid`. Every feed table only appends, so any write changes it. */
const tally = (table: string) => `(SELECT count(*) || ':' || ifnull(max(rowid), 0) FROM ${table})`;
const AGENTS = "(SELECT group_concat(quote(agent_id) || quote(agent_did) || quote(label) || quote(output_resource) || quote(response_resource) || quote(authorization_json), ',') FROM (SELECT * FROM feed_agents ORDER BY agent_id))";

/** The freshness tally of each database the Feed reads. The agent registry is compared by value. */
export const REGISTRY_TALLY = [AGENTS, tally("feed_view_events"), tally("feed_owner_events"), tally("feed_owner_imports")];
export const OUTPUT_TALLY = [tally("feed_cards"), tally("feed_handling")];
export const RESPONSES_TALLY = [tally("feed_responses"), tally("feed_response_payloads")];

export async function readTally(database: FeedReadDatabase, columns: readonly string[]): Promise<unknown[]> {
  return unwrap(await database.query(`SELECT ${columns.join(", ")}`, [])).rows[0] ?? [];
}

const pad = (values: readonly string[], width: number) => [...values, ...Array<string>(width - values.length).fill("NULL")].join(", ");

// Every branch: kind, sort key, then up to 8 values.
const REGISTRY_SQL = `SELECT 'a', agent_id, agent_id, agent_did, label, output_resource, response_resource, authorization_json, NULL, NULL FROM feed_agents
UNION ALL SELECT 'e', seq, agent_id, card_id, revision, issuance_id, kind, created_at, snoozed_until, seq FROM feed_view_events
UNION ALL SELECT 'o', rowid, event_id, agent_id, card_id, revision, issuance_id, event_type, payload_json, created_at FROM feed_owner_events
UNION ALL SELECT 'i', rowid, source_space_id, namespace, snapshot_id, created_at, length(bundle_json), NULL, NULL, NULL FROM feed_owner_imports
UNION ALL SELECT 't', NULL, ${pad(REGISTRY_TALLY, 8)}
ORDER BY 1, 2`;

export interface RegistryRead {
  /** agent_id, agent_did, label, output_resource, response_resource, authorization_json; by agent_id. */
  agents: unknown[][];
  /** agent_id, card_id, revision, issuance_id, kind, created_at, snoozed_until, seq; by seq. */
  views: unknown[][];
  /** `feed_owner_events` rows (event_id … created_at), in rowid order. */
  ownerEvents: unknown[][];
  /** The archive metadata `OwnerArchiveCache` reads, in rowid order. */
  archives: unknown[][];
  tally: unknown[];
}

/** The agent registry, view history, private owner events and archive metadata, in one request. */
export async function readRegistry(registry: FeedReadDatabase): Promise<RegistryRead> {
  const read: RegistryRead = { agents: [], views: [], ownerEvents: [], archives: [], tally: [] };
  for (const row of unwrap(await registry.query(REGISTRY_SQL, [])).rows as unknown[][]) {
    const values = row.slice(2);
    if (row[0] === "a") read.agents.push(values.slice(0, 6));
    else if (row[0] === "e") read.views.push(values);
    else if (row[0] === "o") read.ownerEvents.push(values);
    else if (row[0] === "i") read.archives.push(values.slice(0, 5));
    else if (row[0] === "t") read.tally = values.slice(0, REGISTRY_TALLY.length);
  }
  return read;
}

/**
 * Rows per table per request, as the SDK's own list reads page them: the node
 * refuses a result over 10 MB. Paging follows `sequence`, which only grows, so
 * a later page also holds every row the first page's tally counts.
 */
export const FEED_READ_PAGE = 1000;

// Every branch: kind, sequence, then up to 7 values. Parameters: the sequence to start after, per table.
const OUTPUT_SQL = `SELECT * FROM (SELECT 'c', sequence, card_id, revision, issuance_id, card_json, NULL, NULL, NULL FROM feed_cards WHERE sequence > ? ORDER BY sequence LIMIT ${FEED_READ_PAGE})
UNION ALL SELECT * FROM (SELECT 'h', sequence, response_id, card_id, revision, issuance_id, handling_json, NULL, NULL FROM feed_handling WHERE sequence > ? ORDER BY sequence LIMIT ${FEED_READ_PAGE})
UNION ALL SELECT 't', NULL, NULL, NULL, NULL, NULL, NULL, ${pad(OUTPUT_TALLY, 2)}
ORDER BY 1, 2`;

const RESPONSES_SQL = `SELECT * FROM (SELECT 'r', r.sequence, r.response_json, p.payload_type, p.payload_version, p.payload_json, r.response_id, r.card_id, r.revision, r.issuance_id
  FROM feed_responses r LEFT JOIN feed_response_payloads p ON p.response_id = r.response_id WHERE r.sequence > ? ORDER BY r.sequence LIMIT ${FEED_READ_PAGE})
UNION ALL SELECT 't', NULL, ${pad(RESPONSES_TALLY, 8)}
ORDER BY 1, 2`;

/** SQLite's BINARY order (UTF-8 bytes), which is code point order, not UTF-16 unit order. */
function binaryCompare(a: string, b: string): number {
  const left = [...a], right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}

/**
 * Pages one statement until each table it reads returns a short page. The
 * tally comes from the first page: every later page reads a newer snapshot of
 * append-only tables, so the rows hold at least what it counts.
 */
async function pagedRows(database: FeedReadDatabase, sql: string, kinds: readonly string[]): Promise<{ rows: unknown[][]; tally: unknown[] }> {
  const rows: unknown[][] = [];
  let tally: unknown[] | undefined;
  const after = kinds.map(() => 0);
  let pending = kinds.map((_, index) => index);
  while (pending.length) {
    const page = unwrap(await database.query(sql, after)).rows as unknown[][];
    const counts = kinds.map(() => 0);
    for (const row of page) {
      const index = kinds.indexOf(String(row[0]));
      if (index < 0) { tally ??= row; continue; }
      // A table already read in full returns only rows written since: newer rows are welcome.
      counts[index]!++;
      rows.push(row);
      after[index] = Math.max(after[index]!, Number(row[1]));
    }
    pending = kinds.flatMap((_, index) => counts[index] === FEED_READ_PAGE ? [index] : []);
  }
  return { rows, tally: tally ?? [] };
}

export interface AgentRead {
  /** The newest stored revision of each card, newest first (`listFeedCards`). */
  cards: FeedCard[];
  /** Every stored revision, by card ID, revision and issuance (`listFeedCardHistory`). */
  history: FeedCard[];
  /** Every response and message, by sequence (`listFeedResponses`). */
  responses: FeedResponse[];
  /** `readFeedResponseHandling`; undefined where it answers NOT_FOUND. */
  handling(identity: FeedResponseIdentity): FeedResponseHandling | undefined;
  /** `readFeedResponsePayload`. */
  payload(identity: FeedResponseIdentity): FeedResponsePayload | undefined;
  /** `getFeedCardState`; undefined where it answers NOT_FOUND. */
  cardState(identity: FeedCardIdentity): FeedCardState | undefined;
  /** The output tally, then the responses tally. */
  tally: unknown[];
}

const sameIdentity = (a: FeedCardIdentity, b: FeedCardIdentity) => a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId;
const identityKey = (id: FeedCardIdentity & { responseId?: string }) => JSON.stringify([id.responseId ?? null, id.cardId, id.revision, id.issuanceId]);

function responseHeader(json: unknown) {
  const value: unknown = JSON.parse(String(json));
  const answer = newFeedResponseSchema.safeParse(value);
  return answer.success ? answer.data : newFeedMessageSchema.parse(value);
}

/** One agent's output and response databases: two requests, sent together. */
export async function readAgent(output: FeedReadDatabase, responsesDatabase: FeedReadDatabase): Promise<AgentRead> {
  const [outputRead, responsesRead] = await Promise.all([
    pagedRows(output, OUTPUT_SQL, ["c", "h"]),
    pagedRows(responsesDatabase, RESPONSES_SQL, ["r"]),
  ]);

  const history: FeedCard[] = [];
  const newest = new Map<string, { sequence: number; card: FeedCard }>();
  const handlingRows = new Map<string, unknown[]>();
  try {
    // Rows arrive by sequence: handling stays in sequence order per response.
    for (const row of outputRead.rows) {
      if (row[0] === "c") {
        if (typeof row[5] !== "string") throw new Error("Stored card envelope is invalid");
        const card = JSON.parse(row[5]) as FeedCard;
        feedCardSchema.parse(card);
        if (row[2] !== card.cardId || row[3] !== card.revision || row[4] !== card.issuanceId) throw new Error("Stored card identity does not match its key");
        history.push(card);
        newest.set(card.cardId, { sequence: Number(row[1]), card });
      } else {
        const key = identityKey({ responseId: String(row[2]), cardId: String(row[3]), revision: Number(row[4]), issuanceId: String(row[5]) });
        const rows = handlingRows.get(key) ?? [];
        rows.push(row[6]);
        handlingRows.set(key, rows);
      }
    }
  } catch {
    throw new Error("Could not verify feed card history");
  }
  history.sort((a, b) => binaryCompare(a.cardId, b.cardId) || a.revision - b.revision || binaryCompare(a.issuanceId, b.issuanceId));
  const cards = [...newest.values()].sort((a, b) => b.sequence - a.sequence).map(({ card }) => card);

  const responses: FeedResponse[] = [];
  const payloads = new Map<string, { key: string; type: unknown; version: unknown; json: unknown }>();
  try {
    for (const row of responsesRead.rows) {
      const response: FeedResponse = { ...responseHeader(row[2]), sequence: Number(row[1]) };
      if (row[3] !== null && row[3] !== undefined) {
        response.payloadType = String(row[3]);
        response.payloadVersion = Number(row[4]);
      }
      responses.push(projectFeedResponseNotification(response));
      payloads.set(String(row[6]), { key: identityKey({ responseId: String(row[6]), cardId: String(row[7]), revision: Number(row[8]), issuanceId: String(row[9]) }), type: row[3], version: row[4], json: row[5] });
    }
  } catch {
    throw new Error("Could not list feed responses");
  }

  const handling = (identity: FeedResponseIdentity): FeedResponseHandling | undefined => {
    const rows = handlingRows.get(identityKey(identity));
    if (!rows) return undefined;
    const result: FeedResponseHandling = { acknowledgement: null, outcome: null };
    for (const json of rows) {
      let item: FeedHandling;
      try { item = JSON.parse(String(json)) as FeedHandling; }
      catch { throw new Error("Feed record contains invalid JSON"); }
      if (item.responseId !== identity.responseId || !sameIdentity(item, identity)) throw new Error("Stored handling does not match the response identity");
      if (item.phase === "acknowledged") result.acknowledgement = item;
      else if (item.phase === "succeeded" || item.phase === "failed") result.outcome = item;
      else throw new Error("Stored handling has an unknown phase");
    }
    return result;
  };

  return {
    cards,
    history,
    responses,
    handling,
    payload(identity) {
      const row = payloads.get(identity.responseId);
      if (!row || row.key !== identityKey(identity)) throw new Error("The response identity does not match a saved response");
      if (row.type === null || row.type === undefined) return undefined;
      let data: unknown;
      try { data = JSON.parse(String(row.json)); }
      catch { throw new Error("Could not read the private feed response payload"); }
      const parsed = feedResponsePayloadSchema.safeParse({ type: row.type, version: Number(row.version), data });
      if (!parsed.success) throw new Error("The saved private response payload is invalid");
      return parsed.data;
    },
    cardState(identity) {
      const card = history.find((candidate) => sameIdentity(candidate, identity));
      if (!card) return undefined;
      let response: FeedResponse | null = null;
      for (const candidate of responses) {
        if ((candidate.kind === "answer" || candidate.kind === "followup") && sameIdentity(candidate, identity) && (!response || candidate.sequence > response.sequence)) response = candidate;
      }
      const state = response ? handling(response) : undefined;
      return { card, response, acknowledgement: state?.acknowledgement ?? null, outcome: state?.outcome ?? null };
    },
    tally: [...outputRead.tally.slice(7, 7 + OUTPUT_TALLY.length), ...responsesRead.tally.slice(2, 2 + RESPONSES_TALLY.length)],
  };
}
