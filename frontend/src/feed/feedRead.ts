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
  /** The rows `readPrivateOwnerState` reads, in rowid order. */
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

const OUTPUT_SQL = `SELECT 'c', card_id, revision, issuance_id, sequence, card_json, NULL, NULL, NULL FROM feed_cards
UNION ALL SELECT 'h', response_id, card_id, revision, issuance_id, sequence, handling_json, NULL, NULL FROM feed_handling
UNION ALL SELECT 't', NULL, NULL, NULL, NULL, NULL, ${pad(OUTPUT_TALLY, 3)}
ORDER BY 1, 2, 3, 4, 5, 6`;

const RESPONSES_SQL = `SELECT 'r', r.sequence, r.response_json, p.payload_type, p.payload_version, p.payload_json, r.response_id, r.card_id, r.revision, r.issuance_id
  FROM feed_responses r LEFT JOIN feed_response_payloads p ON p.response_id = r.response_id
UNION ALL SELECT 't', NULL, ${pad(RESPONSES_TALLY, 8)}
ORDER BY 1, 2`;

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
  const [outputRows, responseRows] = await Promise.all([
    output.query(OUTPUT_SQL, []).then((result) => unwrap(result).rows as unknown[][]),
    responsesDatabase.query(RESPONSES_SQL, []).then((result) => unwrap(result).rows as unknown[][]),
  ]);

  const history: FeedCard[] = [];
  const newest = new Map<string, { sequence: number; card: FeedCard }>();
  const handlingRows = new Map<string, unknown[]>();
  let outputTally: unknown[] = [];
  try {
    for (const row of outputRows) {
      if (row[0] === "c") {
        if (typeof row[5] !== "string") throw new Error("Stored card envelope is invalid");
        const card = JSON.parse(row[5]) as FeedCard;
        feedCardSchema.parse(card);
        if (row[1] !== card.cardId || row[2] !== card.revision || row[3] !== card.issuanceId) throw new Error("Stored card identity does not match its key");
        history.push(card);
        const sequence = Number(row[4]);
        if ((newest.get(card.cardId)?.sequence ?? -Infinity) < sequence) newest.set(card.cardId, { sequence, card });
      } else if (row[0] === "h") {
        const key = identityKey({ responseId: String(row[1]), cardId: String(row[2]), revision: Number(row[3]), issuanceId: String(row[4]) });
        const rows = handlingRows.get(key) ?? [];
        rows.push(row[6]);
        handlingRows.set(key, rows);
      } else if (row[0] === "t") outputTally = row.slice(6, 6 + OUTPUT_TALLY.length);
    }
  } catch {
    throw new Error("Could not verify feed card history");
  }
  const cards = [...newest.values()].sort((a, b) => b.sequence - a.sequence).map(({ card }) => card);

  const responses: FeedResponse[] = [];
  const payloads = new Map<string, { key: string; type: unknown; version: unknown; json: unknown }>();
  let responsesTally: unknown[] = [];
  try {
    for (const row of responseRows) {
      if (row[0] === "t") { responsesTally = row.slice(2, 2 + RESPONSES_TALLY.length); continue; }
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
    tally: [...outputTally, ...responsesTally],
  };
}
