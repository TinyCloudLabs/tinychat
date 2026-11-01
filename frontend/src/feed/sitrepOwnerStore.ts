import type { FeedDatabase, FeedResponse, FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import { cardGroup, emptySitrepOwnerData, mergeSitrepStates, ownerThreadResponseKey, parseSitrepCardPayload, validateAnswer, validateClaimDecision, validateGroupPriority, validateSitrepAction, validateState, decodeOwnerThreadMessage, type GroupPriority, type SamState, type SitrepOwnerData, type SitrepHeldNote } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry, HomeFeedOwnerEvent } from "./feedStoreTypes";
import { homeGroupScope, ownerCardKey } from "./feedIdentity";
import { privateFeedDatabase, parseOwnerJSON } from "./privateFeedDatabase";

function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Owner feed state could not be stored");
  return result.data as T;
}

export const OWNER_EVENT_SCHEMA = `CREATE TABLE IF NOT EXISTS feed_owner_events (
  event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, card_id TEXT NOT NULL,
  revision INTEGER NOT NULL, issuance_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
)`;

async function appendPrivateEvent(database: FeedDatabase, entry: HomeFeedEntry, eventId: string, type: "state" | "held-note" | "group-priority", data: unknown, at: string, previousStateRow?: number): Promise<void> {
  database = privateFeedDatabase(database);
  if (!eventId) throw new Error("Private owner event identity is required");
  const card = entry.state.card;
  const values = [eventId, entry.source.sourceId, card.cardId, card.revision, card.issuanceId, type, JSON.stringify(data), at];
  const columns = "feed_owner_events (event_id,agent_id,card_id,revision,issuance_id,event_type,payload_json,created_at)";
  const condition = previousStateRow === undefined ? "" : " WHERE COALESCE((SELECT MAX(rowid) FROM feed_owner_events WHERE agent_id=? AND card_id=? AND revision=? AND issuance_id=? AND event_type='state'),0)=?";
  const params = previousStateRow === undefined ? values : [...values, entry.source.sourceId, card.cardId, card.revision, card.issuanceId, previousStateRow];
  unwrap(await database.execute(`INSERT INTO ${columns} SELECT ?,?,?,?,?,?,?,?${condition || " WHERE 1"} ON CONFLICT(event_id) DO NOTHING`, params));
  const stored = unwrap(await database.query("SELECT agent_id,card_id,revision,issuance_id,event_type,payload_json,created_at FROM feed_owner_events WHERE event_id=?", [eventId]));
  if (!stored.rows.length) throw new Error("Private owner history changed while saving; reload before retrying");
  if (JSON.stringify(stored.rows[0]) !== JSON.stringify(values.slice(1))) throw new Error("Private owner event ID already identifies different content");
}

export async function savePrivateOwnerState(database: FeedDatabase, entry: HomeFeedEntry, event: HomeFeedOwnerEvent): Promise<void> {
  database = privateFeedDatabase(database);
  const payload = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
  if (!event.eventId || !payload) throw new Error("Private owner state does not identify this typed card");
  const action = validateSitrepAction(payload.record, "sitrep.state", event.state, new Date().toISOString());
  if (action.type !== "sitrep.state") throw new Error("Invalid private owner state");
  const state = action.value;
  if (state.seenAt !== undefined || state.snoozedUntil !== undefined || state.snoozes !== undefined) throw new Error("Seen and snooze history belongs to feed_view_events");
  let previousStateRow: number | undefined;
  if (state.notes?.length) {
    const card = entry.state.card;
    const rows = unwrap(await database.query<string | number>("SELECT rowid,payload_json,created_at FROM feed_owner_events WHERE agent_id=? AND card_id=? AND revision=? AND issuance_id=? AND event_type='state' ORDER BY rowid", [entry.source.sourceId, card.cardId, card.revision, card.issuanceId])).rows;
    const history: SamState[] = entry.owner?.states.filter((previous) => previous.kind === state.kind && previous.id === state.id) ?? [];
    previousStateRow = 0;
    for (const row of rows) {
      const [ordinal, json, at] = row;
      if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || typeof json !== "string") throw new Error("Invalid persisted private owner history");
      const parsed = validateState(parseOwnerJSON(json, "Invalid persisted private Home JSON"));
      if (!parsed.ok || parsed.value.updatedAt !== at || parsed.value.kind !== state.kind || parsed.value.id !== state.id) throw new Error("Invalid persisted private owner history");
      history.push(parsed.value); previousStateRow = ordinal;
    }
    const combined = mergeSitrepStates([...history, state], "provided")[0];
    if (!combined || !validateState(combined).ok) throw new Error("Private owner history exceeds a supported limit");
  }
  await appendPrivateEvent(database, entry, event.eventId, "state", state, state.updatedAt, previousStateRow);
}

export async function savePrivateHeldNote(database: FeedDatabase, entry: HomeFeedEntry, note: SitrepHeldNote): Promise<void> {
  const payload = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
  if (!payload || !note.intendedRecipient || note.intendedRecipient.length > 120) throw new Error("Held note has no typed card or logical recipient");
  const checked = validateState({ kind: payload.record.kind, id: payload.record.id, notes: [{ at: note.at, text: note.text }], updatedAt: note.at });
  if (!checked.ok) throw new Error("Held note is invalid");
  const validNote = checked.value.notes?.[0];
  if (!validNote) throw new Error("Held note is invalid");
  await appendPrivateEvent(database, entry, note.eventId, "held-note", { eventId: note.eventId, kind: payload.record.kind, id: payload.record.id, at: note.at, text: validNote.text, intendedRecipient: note.intendedRecipient }, note.at);
}

export async function savePrivateGroupPriority(database: FeedDatabase, entry: HomeFeedEntry, group: string, on: boolean): Promise<void> {
  const payload = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
  if (!payload || cardGroup(payload.record) !== group) throw new Error("Private group decision does not identify this card's group");
  const at = new Date().toISOString();
  const parsed = validateGroupPriority({ groups: { [group]: { on, at } }, updatedAt: at });
  if (!parsed.ok) throw new Error("Invalid private group decision");
  await appendPrivateEvent(database, entry, crypto.randomUUID(), "group-priority", parsed.value, at);
}

export async function readPrivateOwnerState(database: FeedDatabase, archiveScopes?: ReadonlyMap<string, string>): Promise<{ byCard: Record<string, SitrepOwnerData>; groupPriorities: Map<string, GroupPriority> }> {
  database = privateFeedDatabase(database);
  const rows = unwrap(await database.query("SELECT event_id,agent_id,card_id,revision,issuance_id,event_type,payload_json,created_at FROM feed_owner_events ORDER BY rowid", [])).rows;
  const bySource: Record<string, SitrepOwnerData> = {};
  const groupPriorities = new Map<string, GroupPriority>();
  for (const row of rows) {
    const [eventId, sourceId, cardId, revision, issuanceId, type, json, createdAt] = row as unknown[];
    if (typeof eventId !== "string" || typeof sourceId !== "string" || typeof cardId !== "string" || !Number.isSafeInteger(revision) || typeof issuanceId !== "string" || typeof json !== "string" || typeof createdAt !== "string") throw new Error("Invalid persisted private Home event identity");
    const key = ownerCardKey(sourceId, { cardId, revision: Number(revision), issuanceId });
    const owner = bySource[key] ??= emptySitrepOwnerData();
    const data = parseOwnerJSON(json, "Invalid persisted private Home JSON");
    if (type === "state") {
      const parsed = validateState(data);
      if (!parsed.ok || parsed.value.updatedAt !== createdAt || parsed.value.seenAt !== undefined || parsed.value.snoozedUntil !== undefined || parsed.value.snoozes !== undefined) throw new Error("Invalid persisted private Home state");
      owner.states.push(parsed.value);
      if (parsed.value.doneAt || parsed.value.lift || parsed.value.clears?.length) (owner.commands ??= []).push({ eventId, state: parsed.value });
    } else if (type === "held-note") {
      if (!data || typeof data !== "object" || !("eventId" in data) || data.eventId !== eventId || !("at" in data) || data.at !== createdAt || !("text" in data) || typeof data.text !== "string" || !("kind" in data) || !("id" in data) || !("intendedRecipient" in data) || typeof data.intendedRecipient !== "string" || !data.intendedRecipient || data.intendedRecipient.length > 120) throw new Error("Invalid persisted held note");
      const checked = validateState({ kind: data.kind, id: data.id, steps: {}, notes: [{ at: data.at, text: data.text }], updatedAt: data.at });
      const note = checked.ok ? checked.value.notes?.[0] : undefined;
      if (!note) throw new Error("Invalid persisted held note");
      (owner.heldNotes ??= []).push({ eventId, at: createdAt, text: note.text, intendedRecipient: data.intendedRecipient });
    } else if (type === "group-priority") {
      const parsed = validateGroupPriority(data);
      if (!parsed.ok || parsed.value.updatedAt !== createdAt) throw new Error("Invalid persisted private group decision");
      const scope = homeGroupScope(sourceId, archiveScopes?.get(key));
      const combined = validateGroupPriority({ groups: { ...groupPriorities.get(scope)?.groups, ...parsed.value.groups }, updatedAt: createdAt });
      if (!combined.ok) throw new Error("Private group history exceeds its supported limit");
      groupPriorities.set(scope, combined.value);
      owner.groupPriority = { groups: { ...owner.groupPriority?.groups, ...parsed.value.groups }, updatedAt: createdAt };
    } else throw new Error("Unsupported persisted private Home event");
  }
  for (const owner of Object.values(bySource)) owner.states = mergeSitrepStates(owner.states, "provided");
  return { byCard: bySource, groupPriorities };
}

/** Only explicit payload reads reach this owner-only projection. */
export function addCanonicalOwnerEvent(owner: SitrepOwnerData, entry: HomeFeedEntry, response: FeedResponse, payload: FeedResponsePayload): ReturnType<typeof decodeOwnerThreadMessage> | undefined {
  const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
  if (!typed || payload.version !== 1) throw new Error("Unsupported typed response payload version");
  const record = typed.record;
  const sourceKey = owner.responseOrigins?.[response.responseId]?.sourceKey ?? `response/${entry.source.sourceId}/${response.responseId}`;
  if (!Object.hasOwn(owner.responseOrigins ?? {}, response.responseId)) (owner.responseOrigins ??= Object.create(null))[response.responseId] = { sourceKey, eventKey: sourceKey };
  if (response.kind === "message" && (payload.type === "sitrep.answer" || payload.type === "sitrep.claim")) {
    (owner.unsupportedResponses ??= []).push({ responseId: response.responseId, reason: "Message payload cannot answer a card" });
    return;
  }
  if (payload.type === "sitrep.answer") {
    const parsed = validateAnswer(payload.data);
    if (!parsed.ok || parsed.value.askId !== record.id || (record.kind !== "ask" && record.kind !== "approval")) throw new Error("Stored answer payload does not address its canonical card");
    const prior = owner.answers.find((answer) => answer.sourceKey === sourceKey);
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(parsed.value)) throw new Error("Conflicting immutable owner answer");
    if (!prior) owner.answers.push({ sourceKey, card: { kind: record.kind, id: record.id }, value: parsed.value });
  } else if (payload.type === "sitrep.claim") {
    const parsed = validateClaimDecision(payload.data);
    if (!parsed.ok || record.kind !== "claim") throw new Error("Stored claim decision does not address a claim");
    const prior = owner.claimDecisions.find((decision) => decision.sourceKey === sourceKey);
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(parsed.value)) throw new Error("Conflicting immutable claim decision");
    if (!prior) owner.claimDecisions.push({ sourceKey, card: { kind: "claim", id: record.id }, value: parsed.value });
  } else if (payload.type === "sitrep.thread") {
    if (response.kind !== "message") throw new Error("A card message cannot masquerade as an answer");
    const decoded = decodeOwnerThreadMessage(record, payload.data);
    const message = decoded.message;
    owner.threads.push(message);
    const key = ownerThreadResponseKey(message);
    (owner.threadResponses ??= {})[key] = response.responseId;
    (owner.threadOrigins ??= {})[key] ??= { kind: "owner-response", responseId: response.responseId };
    return decoded;
  } else if (payload.type === "sitrep.state") {
    // Agent-intended commands are deliberately minimal. Private snapshots may
    // never be reconstructed from or copied to this agent-readable database.
    const parsed = validateState(payload.data);
    if (response.kind !== "message" || !parsed.ok || parsed.value.kind !== record.kind || parsed.value.id !== record.id || parsed.value.notes !== undefined || parsed.value.snoozes !== undefined || parsed.value.priority !== undefined || parsed.value.seenAt !== undefined || parsed.value.snoozedUntil !== undefined || parsed.value.dismissedAt !== undefined || Object.keys(parsed.value.steps).length) throw new Error("Private state was placed in an agent-readable response");
    if (!parsed.value.doneAt && !parsed.value.lift && !parsed.value.clears?.length) throw new Error("Unknown owner command");
    // A message records an intended command, never a replacement for private
    // owner state. The actual intent was committed separately in owner_events.
  } else if (payload.type === "sitrep.note" || payload.type === "sitrep.hold-notice") {
    if (response.kind !== "message" || !owner.outboundNotes?.some((note) => note.responseId === response.responseId)) {
      (owner.unsupportedResponses ??= []).push({ responseId: response.responseId, reason: "Historical message has no validated owner archive provenance" });
    }
  }
}

/** Group preferences are resolved separately by validated scope, not combined across histories. */
export function combineOwnerData(owners: readonly SitrepOwnerData[]): SitrepOwnerData {
  const result = emptySitrepOwnerData();
  for (const owner of owners) {
    result.answers.push(...owner.answers); result.states.push(...owner.states);
    result.claimDecisions.push(...owner.claimDecisions); result.threads.push(...owner.threads); result.deliveries.push(...owner.deliveries);
    if (owner.heldNotes) (result.heldNotes ??= []).push(...owner.heldNotes);
    if (owner.commands) (result.commands ??= []).push(...owner.commands);
    if (owner.threadResponses) Object.assign(result.threadResponses ??= {}, owner.threadResponses);
    if (owner.threadOrigins) Object.assign(result.threadOrigins ??= Object.create(null), owner.threadOrigins);
    if (owner.responseOrigins) Object.assign(result.responseOrigins ??= Object.create(null), owner.responseOrigins);
    if (owner.outboundNotes) (result.outboundNotes ??= []).push(...owner.outboundNotes);
    if (owner.unsupportedResponses) (result.unsupportedResponses ??= []).push(...owner.unsupportedResponses);
  }
  result.states = mergeSitrepStates(result.states, "provided");
  const immutableMessages = new Map<string, typeof result.threads[number]>();
  for (const message of result.threads) {
    const key = JSON.stringify([message.kind, message.id, message.side, message.messageId]);
    const previous = immutableMessages.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new Error("Conflicting immutable card message");
    immutableMessages.set(key, message);
  }
  result.threads = [...immutableMessages.values()];
  return result;
}
