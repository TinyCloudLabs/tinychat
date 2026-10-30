import { z } from "zod";
import { parseKey, isKind, validateAnswer, validateClaimDecision, validateGroupPriority, validateRecord, validateState, type Answer, type BoardRecord } from "./schema";
import { parseThreadKey, parseThreadMessage, threadOwner } from "./card-thread";
import { recipients } from "./recipients";
import { effectivePriority } from "./priority";
import { emptySitrepOwnerData, mergeSitrepStates, projectSitrepCard, safeSitrepActionSummary } from "./model";
import { SITREP_MODEL_ORIGINS } from "./origins";
import type { SitrepOwnerData } from "./model-types";
import type { JSONValue, PrepareSitrepImportInput, PreparedCard, PreparedDelivery, PreparedOwnerResponse, PreparedSourceRow, PreparedSitrepImportBundle } from "./import-bundle";
import { importedExecutionWindow, hasCapturedPendingEvidence } from "./delivery-window";
import { LEGACY_NOTE_KINDS, decodeLegacySendNote } from "./legacy-notes";
import { decodeOwnerThreadMessage, ownerThreadResponseKey } from "./thread-payload";
import { mappedPreparedRecipient, prepareEventRecipients } from "./prepared-recipients";

const WatchSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), cursor: z.string(), delivered: z.record(z.object({ done: z.array(z.string()), complete: z.boolean() })), claimDelivered: z.record(z.string()).optional(), prunedThrough: z.string().optional(), claimsSince: z.string().optional(), tasks: z.record(z.record(z.string().nullable())), taskClosed: z.record(z.string()).optional(), chatReceipt: z.string().optional() });
const AttemptSchema = z.object({ state: z.enum(["waiting", "claimed", "delivered", "unconfirmed", "refused"]), recipient: z.string(), routedTo: z.enum(["owner", "xo"]), at: z.string().optional(), updatedAt: z.string().optional(), reason: z.string().optional(), absentPolls: z.number().int().nonnegative().optional() });
const ThreadWatchSchema = z.object({ attempts: z.record(AttemptSchema), cursor: z.string().optional() });
const ExpirySchema = z.object({ version: z.literal(1), since: z.string(), firstRun: z.record(z.array(z.string())), owed: z.record(z.string()).optional() });
const Iso = z.string().datetime({ offset: true });
const HoldActionsSchema = z.object({ version: z.literal(1), acted: z.record(z.object({ at: Iso, outcome: z.enum(["recorded", "applied", "noop", "ignored"]) }).strict()), owed: z.record(z.object({ to: z.string(), line: z.string(), at: Iso, sending: Iso.optional() }).strict()) }).strict();

export function jsonValue(input: unknown): JSONValue {
  if (input === null || typeof input === "string" || typeof input === "boolean" || (typeof input === "number" && Number.isFinite(input))) return input;
  if (Array.isArray(input)) { for (const item of input) jsonValue(item); return input as JSONValue[]; }
  if (input && typeof input === "object" && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) {
    for (const value of Object.values(input)) jsonValue(value);
    return input as { [key: string]: JSONValue };
  }
  throw new Error("Expected strict JSON data");
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function stableId(input: unknown): Promise<string> { return `sitrep-${await sha256(new TextEncoder().encode(JSON.stringify(input)))}`; }
function object(input: unknown): input is Record<string, unknown> { return input !== null && typeof input === "object" && !Array.isArray(input); }
function sameIdentity(a: { cardId: string; revision: number; issuanceId: string }, b: { cardId: string; revision: number; issuanceId: string }) { return a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId; }
async function verifySourceBytes(row: Omit<PreparedSourceRow, "classification">, namespace: string): Promise<void> {
  if (typeof row.sourceKey !== "string" || !row.sourceKey || !["kv", "watch-state", "thread-watch-state", "expiry-state"].includes(row.sourceArea) || (row.sourceArea === "kv" && !row.sourceKey.startsWith(namespace))) throw new Error("Source key lies outside its frozen source scope");
  if (row.encoding !== "base64" || typeof row.rawBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.rawBase64)) throw new Error("Source bytes must use canonical base64");
  const bytes = Uint8Array.from(atob(row.rawBase64), (char) => char.charCodeAt(0));
  if (await sha256(bytes) !== row.sha256) throw new Error("Source byte digest does not match");
}

/** No I/O, grants, dispatch, or legacy rule evaluation is delegated to an importer. */
export async function prepareSitrepImport(input: PrepareSitrepImportInput): Promise<PreparedSitrepImportBundle> {
  const { source, previous } = input;
  if (typeof source.spaceId !== "string" || !source.spaceId || typeof source.namespace !== "string" || !source.namespace.endsWith("/") || typeof source.snapshotId !== "string" || !source.snapshotId || typeof source.completePrefixSnapshot !== "boolean" || !Number.isFinite(Date.parse(input.frozenAt))) throw new Error("A frozen source scope, snapshot and time are required");
  if (previous && (previous.formatVersion !== 1 || previous.modelVersion !== 1 || previous.source.spaceId !== source.spaceId || previous.source.namespace !== source.namespace)) throw new Error("Previous snapshot belongs to a different source scope");
  const previousSnapshotId = previous && previous.source.snapshotId === source.snapshotId ? previous.source.previousSnapshotId : previous?.source.snapshotId;
  const frozenSource = { spaceId: source.spaceId, namespace: source.namespace, snapshotId: source.snapshotId, completePrefixSnapshot: source.completePrefixSnapshot, ...(source.cursor !== undefined ? { cursor: source.cursor } : {}), ...(source.revision !== undefined ? { revision: source.revision } : {}), ...(previousSnapshotId ? { previousSnapshotId } : {}) };
  const recreated = new Set(input.rows.map((row) => row.sourceKey));
  const deletions = new Map((previous?.deletions ?? []).filter((row) => !recreated.has(row.sourceKey)).map((row) => [row.sourceKey, { ...row }]));
  for (const deletion of input.deletions ?? []) {
    if (recreated.has(deletion.sourceKey)) throw new Error("A snapshot cannot both recreate and delete the same source key");
    deletions.set(deletion.sourceKey, { ...deletion });
  }
  const result: PreparedSitrepImportBundle = { formatVersion: 1, modelVersion: 1, frozenAt: input.frozenAt, source: frozenSource, origins: [...SITREP_MODEL_ORIGINS], sourceRows: [], publishers: input.publishers, recipients: input.recipients, routes: [], cards: [], ownerResponses: [], ownerState: [], threads: [], deliveries: [], checkpoints: [], deletions: [...deletions.values()], quarantine: [] };
  const publishers = new Map(input.publishers.map((publisher) => [publisher.publisherId, publisher]));
  const agentIds = new Set<string>(); const resourceLeaves = new Set<string>();
  if (publishers.size !== input.publishers.length) throw new Error("Publisher IDs must be unique");
  for (const publisher of input.publishers) {
    if (![publisher.publisherId, publisher.agentId, publisher.agentDid, publisher.outputResource, publisher.responseResource].every((field) => typeof field === "string" && field.length)) throw new Error("Publisher binding is incomplete");
    if (agentIds.has(publisher.agentId)) throw new Error("Publisher owner tokens must be unique");
    agentIds.add(publisher.agentId);
    for (const resource of [publisher.outputResource, publisher.responseResource]) {
      const leaf = resource.split("/").at(-1)!;
      if (!resource.includes("/") || !leaf || resourceLeaves.has(leaf)) throw new Error("Publisher databases must have unique authorized resource leaves");
      resourceLeaves.add(leaf);
    }
  }
  const recipientKeys = new Set<string>();
  for (const recipient of input.recipients) {
    if (!recipient.recipientKey || !recipient.legacyName || recipientKeys.has(recipient.recipientKey)) throw new Error("Logical recipient keys must be explicit and unique");
    recipientKeys.add(recipient.recipientKey);
  }
  const recipientFor = (name: string) => mappedPreparedRecipient(input.recipients, name);
  const identityOf = (value: PreparedCard["identity"]): PreparedCard["identity"] => {
    if (typeof value.cardId !== "string" || !value.cardId || typeof value.issuanceId !== "string" || !value.issuanceId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Full canonical card identity is required");
    return { cardId: value.cardId, revision: value.revision, issuanceId: value.issuanceId };
  };
  const bindings = new Map((previous?.cards ?? []).map((card) => [card.sourceKey, { sourceKey: card.sourceKey, publisherId: card.publisherId, identity: identityOf(card.identity) }]));
  if (bindings.size !== (previous?.cards.length ?? 0)) throw new Error("Previous source-key bindings are ambiguous");
  const incomingBindings = new Set<string>();
  for (const binding of input.publisherBindings) {
    if (incomingBindings.has(binding.sourceKey)) throw new Error("Ambiguous source-key publisher binding");
    incomingBindings.add(binding.sourceKey);
    bindings.set(binding.sourceKey, { sourceKey: binding.sourceKey, publisherId: binding.publisherId, identity: identityOf(binding.identity) });
  }
  const archive = new Map((previous?.sourceRows ?? []).map((row) => [row.sourceKey, { ...row }]));
  if (archive.size !== (previous?.sourceRows.length ?? 0)) throw new Error("Previous full source keys are ambiguous");
  for (const row of previous?.sourceRows ?? []) await verifySourceBytes(row, source.namespace);
  const active = new Map<string, PreparedSourceRow>(source.completePrefixSnapshot ? [] : archive);
  const incomingKeys = new Set<string>();
  for (const row of input.rows) {
    if (incomingKeys.has(row.sourceKey)) throw new Error("Duplicate full source key");
    incomingKeys.add(row.sourceKey);
    await verifySourceBytes(row, source.namespace);
    const prior = archive.get(row.sourceKey);
    const key = parseKey(row.sourceKey);
    const immutable = key?.area === "answer" || key?.area === "claim-decision" || parseThreadKey(row.sourceKey) !== null;
    if (prior && immutable && (prior.sourceArea !== row.sourceArea || prior.encoding !== row.encoding || prior.sha256 !== row.sha256 || prior.rawBase64 !== row.rawBase64)) throw new Error("An immutable owner event source key cannot identify different bytes");
    const value: PreparedSourceRow = { ...row, classification: "quarantine" };
    archive.set(row.sourceKey, value); active.set(row.sourceKey, value);
  }
  if (source.completePrefixSnapshot && previous) {
    for (const row of previous.sourceRows) {
      if (row.sourceArea !== "kv") { if (!incomingKeys.has(row.sourceKey)) active.set(row.sourceKey, archive.get(row.sourceKey)!); continue; }
      if (!incomingKeys.has(row.sourceKey) && !result.deletions.some((deletion) => deletion.sourceKey === row.sourceKey)) result.deletions.push({ sourceKey: row.sourceKey, classification: row.classification, previousSha256: row.sha256, deletedAt: input.frozenAt });
    }
  }
  for (const deletion of result.deletions) {
    const prior = previous?.sourceRows.find((row) => row.sourceKey === deletion.sourceKey);
    if (!deletion.sourceKey.startsWith(source.namespace) && !prior) throw new Error("Deletion lies outside its frozen source scope");
    if (deletion.previousSha256 && prior && deletion.previousSha256 !== prior.sha256) throw new Error("Deletion does not match the archived source revision");
    active.delete(deletion.sourceKey);
  }
  const decoded = new Map<string, unknown>();
  const quarantine = (row: PreparedSourceRow, reason: PreparedSitrepImportBundle["quarantine"][number]["reason"], detail: string) => { row.classification = "quarantine"; result.quarantine.push({ sourceKey: row.sourceKey, reason, detail }); };
  for (const row of active.values()) row.classification = "quarantine";
  for (const row of active.values()) {
    try { const bytes = Uint8Array.from(atob(row.rawBase64), (char) => char.charCodeAt(0)); decoded.set(row.sourceKey, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { quarantine(row, "invalid", "Source bytes are not UTF-8 JSON; original bytes retained"); }
  }
  const records = new Map<string, { record: BoardRecord; row: PreparedSourceRow }>();
  for (const row of active.values()) {
    if (!decoded.has(row.sourceKey) || row.sourceArea !== "kv") continue;
    const key = parseKey(row.sourceKey);
    if (key?.area !== "board") continue;
    const parsed = validateRecord(key.kind, decoded.get(row.sourceKey));
    if (!parsed.ok || parsed.value.kind !== key.kind || parsed.value.id !== key.id) { quarantine(row, "invalid", "Record does not match its full source key"); continue; }
    row.classification = "card"; records.set(row.sourceKey, { record: parsed.value, row });
  }
  const cardByRef = (kind: string, id: string) => [...records.entries()].filter(([, item]) => item.record.kind === kind && item.record.id === id);
  const cardForAnswer = (id: string) => [...records.entries()].filter(([, item]) => (item.record.kind === "ask" || item.record.kind === "approval") && item.record.id === id);
  const owner = emptySitrepOwnerData();
  const rawAnswers: { row: PreparedSourceRow; value: Answer; cardKey: string }[] = [];
  const eventSpecs: { row: PreparedSourceRow; eventKey: string; cardKey: string; kind: PreparedOwnerResponse["ownerEventKind"]; type: string; data: JSONValue; at: string; answer?: Answer }[] = [];
  for (const row of active.values()) {
    if (!decoded.has(row.sourceKey) || row.sourceArea !== "kv" || row.classification === "card") continue;
    const value = decoded.get(row.sourceKey); const key = parseKey(row.sourceKey);
    if (key?.area === "answer") {
      const parsed = validateAnswer(value); const matches = cardForAnswer(key.askId);
      if (!parsed.ok || parsed.value.askId !== key.askId || Date.parse(parsed.value.at) !== Date.parse(key.at)) { quarantine(row, "invalid", "Answer does not match its source key/time"); continue; }
      if (matches.length !== 1) { quarantine(row, matches.length ? "ambiguous-reference" : "orphan-reference", "Answer must identify exactly one typed record"); continue; }
      const [cardKey, item] = matches[0]!; row.classification = "answer";
      owner.answers.push({ sourceKey: row.sourceKey, card: { kind: item.record.kind, id: item.record.id }, value: parsed.value });
      rawAnswers.push({ row, value: parsed.value, cardKey });
      eventSpecs.push({ row, eventKey: row.sourceKey, cardKey, kind: "answer", type: "sitrep.answer", data: jsonValue(parsed.value), at: parsed.value.at, answer: parsed.value });
    } else if (key?.area === "state") {
      const parsed = validateState(value);
      if (!parsed.ok || parsed.value.kind !== key.kind || parsed.value.id !== key.id) { quarantine(row, "invalid", "State does not match its full source key"); continue; }
      row.classification = "owner-state"; owner.states.push(parsed.value); result.ownerState.push({ sourceKey: row.sourceKey, type: "state", value: parsed.value });
      const matches = cardByRef(key.kind, key.id);
      if (matches.length !== 1) { result.quarantine.push({ sourceKey: row.sourceKey, reason: matches.length ? "ambiguous-reference" : "orphan-reference", detail: "Owner state retained; no canonical event target was guessed" }); continue; }
      const state = parsed.value;
      // The raw state is owner-only. Only source-backed explicit outbound
      // notes and minimal commands receive separate recipient-bound envelopes.
      if (state.kind === "task" && state.doneAt) eventSpecs.push({ row, eventKey: `done:${state.id}`, cardKey: matches[0]![0], kind: "state", type: "sitrep.state", data: { kind: "task", id: state.id, steps: {}, doneAt: state.doneAt, updatedAt: state.doneAt }, at: state.doneAt });
      if (state.kind === "hold" && state.lift) eventSpecs.push({ row, eventKey: `lift:${state.id}|${state.lift.at}`, cardKey: matches[0]![0], kind: "state", type: "sitrep.state", data: { kind: "hold", id: state.id, steps: {}, lift: jsonValue(state.lift), updatedAt: state.lift.at }, at: state.lift.at });
      if (state.kind === "hold") for (const clear of state.clears ?? []) eventSpecs.push({ row, eventKey: `clear:${state.id}|${clear.ref}|${clear.id}`, cardKey: matches[0]![0], kind: "state", type: "sitrep.state", data: { kind: "hold", id: state.id, steps: {}, clears: [jsonValue(clear)], updatedAt: clear.at }, at: clear.at });
      if (LEGACY_NOTE_KINDS.has(state.kind)) {
        const notes = new Map<string, NonNullable<typeof state.notes>[number]>();
        const conflicting = new Set<string>();
        for (const note of state.notes ?? []) {
          if (notes.has(note.id) && JSON.stringify(notes.get(note.id)) !== JSON.stringify(note)) conflicting.add(note.id);
          notes.set(note.id, note);
        }
        for (const note of notes.values()) {
          if (conflicting.has(note.id)) { result.quarantine.push({ sourceKey: row.sourceKey, reason: "ambiguous-reference", detail: "Conflicting legacy send-note event identity; raw state retained" }); continue; }
          const eventKey = `note:${state.kind}/${state.id}/${note.id}`;
          eventSpecs.push({ row, eventKey, cardKey: matches[0]![0], kind: "note", type: "sitrep.note", data: { kind: state.kind, id: state.id, noteId: note.id, at: note.at, text: note.text, sourceKey: row.sourceKey, eventKey }, at: note.at });
        }
      }
    } else if (key?.area === "claim-decision") {
      const parsed = validateClaimDecision(value); const matches = cardByRef("claim", key.id);
      if (!parsed.ok || Date.parse(parsed.value.at) !== Date.parse(key.at)) { quarantine(row, "invalid", "Claim decision does not match its source time"); continue; }
      row.classification = "claim-decision"; const card = { kind: "claim" as const, id: key.id };
      owner.claimDecisions.push({ sourceKey: row.sourceKey, card, value: parsed.value }); result.ownerState.push({ sourceKey: row.sourceKey, type: "claim-decision", card, value: parsed.value });
      if (matches.length === 1) eventSpecs.push({ row, eventKey: row.sourceKey, cardKey: matches[0]![0], kind: "claim", type: "sitrep.claim", data: jsonValue(parsed.value), at: parsed.value.at });
      else result.quarantine.push({ sourceKey: row.sourceKey, reason: matches.length ? "ambiguous-reference" : "orphan-reference", detail: "Claim target was not guessed" });
    } else if (key?.area === "prefs") {
      const parsed = validateGroupPriority(value);
      if (!parsed.ok) { quarantine(row, "invalid", "Invalid group priority preference"); continue; }
      row.classification = "group-preference"; owner.groupPriority = parsed.value; result.ownerState.push({ sourceKey: row.sourceKey, type: "group-preference", value: parsed.value });
    } else if (parseThreadKey(row.sourceKey)) {
      const message = parseThreadMessage(row.sourceKey, value);
      if (!message) { quarantine(row, "invalid", "Thread ID, time or body is invalid"); continue; }
      row.classification = "thread"; owner.threads.push(message);
      const matches = cardByRef(message.kind, message.id);
      const binding = matches.length === 1 ? bindings.get(matches[0]![0]) : undefined;
      if (!binding || !publishers.has(binding.publisherId)) { result.quarantine.push({ sourceKey: row.sourceKey, reason: "unmapped-publisher", detail: "Thread retained owner-only; its publisher was not guessed" }); continue; }
      result.threads.push({ sourceKey: row.sourceKey, publisherId: binding.publisherId, identity: binding.identity, message });
      if (message.side === "sam") eventSpecs.push({ row, eventKey: row.sourceKey, cardKey: matches[0]![0], kind: "thread", type: "sitrep.thread", data: jsonValue(message), at: message.at });
    } else if (key?.area === "receipt") {
      row.classification = "receipt"; result.checkpoints.push({ sourceKey: row.sourceKey, type: "chat-receipt", value: jsonValue(value) });
    }
  }
  owner.states = mergeSitrepStates(owner.states);
  const holdActions = new Map<string, z.infer<typeof HoldActionsSchema>>();
  for (const row of active.values()) {
    if (row.sourceArea !== "watch-state") continue;
    const parsed = HoldActionsSchema.safeParse(decoded.get(row.sourceKey));
    if (!parsed.success) continue;
    holdActions.set(row.sourceKey, parsed.data);
    row.classification = "checkpoint";
    result.checkpoints.push({ sourceKey: row.sourceKey, type: "hold-actions", value: jsonValue(parsed.data) });
    for (const [eventKey, notice] of Object.entries(parsed.data.owed)) {
      const suffix = `@${notice.to}`;
      const match = eventKey.startsWith("notice:") && eventKey.endsWith(suffix) ? /^(?:lift|clear):([^|]+)\|/.exec(eventKey.slice(7, -suffix.length)) : null;
      const matches = match ? cardByRef("hold", match[1]!) : [];
      if (matches.length !== 1) { result.quarantine.push({ sourceKey: row.sourceKey, reason: "orphan-reference", detail: "Hold notice cannot be bound to its original hold and recipient" }); continue; }
      eventSpecs.push({ row, eventKey, cardKey: matches[0]![0], kind: "hold-notice", type: "sitrep.hold-notice", data: { noticeKey: eventKey, to: notice.to, line: notice.line, at: notice.at }, at: notice.at });
    }
  }
  // Source tombstones cannot retract an append-only decision. Restore its owner
  // meaning, but never add it back to eventSpecs/rawAnswers or dispatch policy.
  for (const row of archive.values()) {
    if (active.has(row.sourceKey)) continue;
    const key = parseKey(row.sourceKey);
    if (key?.area !== "answer") continue;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(row.rawBase64), (char) => char.charCodeAt(0)))); }
    catch { if (row.classification === "answer") throw new Error("Invalid archived domain answer"); continue; }
    const parsed = validateAnswer(value);
    if (!parsed.ok) { if (row.classification === "answer") throw new Error("Invalid archived domain answer"); continue; }
    if (parsed.value.askId !== key.askId || Date.parse(parsed.value.at) !== Date.parse(key.at)) throw new Error("Archived answer does not match its source identity");
    const matches = cardForAnswer(key.askId);
    const item = matches.length === 1 ? matches[0]?.[1] : undefined;
    if (item) owner.answers.push({ sourceKey: row.sourceKey, card: { kind: item.record.kind, id: item.record.id }, value: parsed.value });
  }
  const identities = new Set<string>();
  for (const [sourceKey, { record, row }] of records) {
    const binding = bindings.get(sourceKey);
    if (!binding || !publishers.has(binding.publisherId)) { quarantine(row, "unmapped-publisher", "An explicit registered publisher and canonical identity binding is required"); continue; }
    const identityKey = JSON.stringify([binding.publisherId, binding.identity]);
    if (identities.has(identityKey)) { quarantine(row, "ambiguous-reference", "Two legacy cards cannot share one canonical identity"); continue; }
    identities.add(identityKey);
    const prior = previous?.cards.find((card) => card.sourceKey === sourceKey);
    if (prior && previous?.sourceRows.find((old) => old.sourceKey === sourceKey)?.sha256 !== row.sha256 && sameIdentity(prior.identity, binding.identity)) { quarantine(row, "unresolved-issuance", "Changed content requires an explicit new canonical identity"); continue; }
    const projection = projectSitrepCard(record, [...records.values()].map((item) => item.record), owner, Date.parse(input.frozenAt));
    const currentAnswerSourceKey = projection.answer ? owner.answers.find((entry) => entry.value === projection.answer)?.sourceKey : undefined;
    const canonicalCard: PreparedCard["canonicalCard"] = {
      ...binding.identity, kind: record.kind, needsResponse: projection.request,
      title: record.title, body: record.body,
      ...(record.kind === "ask" ? { choices: record.options.map((option) => ({ id: option.id, label: option.label })) } : {}),
      urgency: effectivePriority(record).urgency, createdAt: record.createdAt,
      payload: { sitrep: { version: 1, record }, source: { label: "Legacy source", ref: sourceKey }, ...(record.repo ? { project: record.repo } : {}) },
    };
    const card: PreparedCard = { sourceKey, publisherId: binding.publisherId, identity: binding.identity, record, canonicalCard, needsAction: projection.needsAction, attention: projection.attention, ...(currentAnswerSourceKey ? { currentAnswerSourceKey } : {}), ...(projection.foldedInto ? { foldedInto: projection.foldedInto } : {}) };
    result.cards.push(card);
    const names = recipients(record);
    result.routes.push({ sourceKey, card: { kind: record.kind, id: record.id }, recipientKeys: names.flatMap((name) => { const recipient = recipientFor(name); return recipient ? [recipient.recipientKey] : []; }), fallbackRecipientKeys: recipientFor("xo") ? [recipientFor("xo")!.recipientKey] : [], unresolvedRecipients: names.filter((name) => !recipientFor(name)) });
  }
  const envelopes = new Map<string, PreparedOwnerResponse>();
  const eventRecipients = new Map<string, string[]>();
  for (const event of eventSpecs) {
    const card = result.cards.find((item) => item.sourceKey === event.cardKey);
    const binding = bindings.get(event.row.sourceKey) ?? bindings.get(event.cardKey);
    if (!card || !binding || !publishers.has(binding.publisherId)) { result.quarantine.push({ sourceKey: event.row.sourceKey, reason: "unmapped-publisher", detail: "Owner event retained without inventing a publisher" }); continue; }
    if (event.answer && card.record.kind === "approval" && event.answer.issuedAt && event.answer.issuedAt !== card.record.issuedAt && !incomingBindings.has(event.row.sourceKey)) { result.quarantine.push({ sourceKey: event.row.sourceKey, reason: "unresolved-issuance", detail: "Historical approval issuance needs an explicit source-key binding" }); continue; }
    const responseId = await stableId([source.spaceId, source.namespace, event.eventKey, binding.publisherId, binding.identity]);
    const summary = event.answer ? safeSitrepActionSummary({ type: "sitrep.answer", value: event.answer }) : event.kind === "thread" ? "Historical card message" : event.kind === "claim" ? "Historical claim decision" : event.kind === "note" ? "Historical explicit owner note" : event.kind === "hold-notice" ? "Historical hold notice" : "Historical owner command";
    const payload = { type: event.type, version: 1, data: event.data };
    const route = prepareEventRecipients(card.record, { ownerEventKind: event.kind, ...(event.answer ? { legacyAnswer: event.answer } : {}), payload }, input.recipients);
    eventRecipients.set(event.eventKey, route.names);
    const header = { ...binding.identity, responseId, kind: event.kind === "answer" || event.kind === "claim" ? "answer" as const : "message" as const, text: summary, createdAt: event.at };
    const envelope: PreparedOwnerResponse = { sourceKey: event.row.sourceKey, eventKey: event.eventKey, publisherId: binding.publisherId, card: { kind: card.record.kind, id: card.record.id }, response: header, ownerEventKind: event.kind, payload, restoreTarget: route.restoreTarget, recipientKeys: route.recipientKeys, unresolvedRecipients: route.unresolvedRecipients, ...(event.answer ? { legacyAnswer: event.answer } : {}) };
    result.ownerResponses.push(envelope); envelopes.set(event.eventKey, envelope);
  }
  const appendDelivery = (receiptKey: string, eventKey: string, name: string, state: PreparedDelivery["state"], evidence: PreparedDelivery["evidence"], raw: unknown, at?: string, routedTo: "owner" | "xo" = name === "xo" ? "xo" : "owner") => {
    const event = envelopes.get(eventKey); const recipient = recipientFor(name);
    if (!event || !recipient) { if (!recipient) result.quarantine.push({ sourceKey: receiptKey, reason: "unsupported-receipt", detail: `Unmapped logical recipient ${name}; original receipt retained` }); return; }
    const spec = eventSpecs.find((item) => item.eventKey === eventKey)!;
    const record = records.get(spec.cardKey)!.record;
    const window = importedExecutionWindow(record, event, input.frozenAt);
    const dispatchBefore = window.dispatchBefore;
    let reason: string | undefined;
    if (state === "pending" && window.refusal) { state = "refused"; reason = window.refusal; }
    else if (state === "pending" && window.heldReason) { state = "held"; reason = window.heldReason; }
    if (state === "pending" && !hasCapturedPendingEvidence(record, event, name, decoded.get(receiptKey), active.get(receiptKey)?.sourceArea ?? "")) { state = "held"; reason = "No positive captured pending evidence"; }
    const terminal = state === "delivered" || state === "unconfirmed" || state === "refused";
    const eligible = state === "pending" && recipient.runtimeTarget && event.restoreTarget === "agent-response" && (dispatchBefore === null || Date.parse(dispatchBefore) > Date.parse(input.frozenAt));
    const dispatch: PreparedDelivery["dispatch"] = terminal ? "never" : eligible ? "resolved-pending" : "held";
    result.deliveries.push({ sourceKey: receiptKey, eventSourceKey: event.sourceKey, eventKey, publisherId: event.publisherId, identity: { cardId: event.response.cardId, revision: event.response.revision, issuanceId: event.response.issuanceId }, responseId: event.response.responseId, recipientKey: recipient.recipientKey, recipient: name, state: terminal ? state : eligible ? "pending" : "held", routedTo, ...(at ? { at } : {}), ...(reason ? { reason } : {}), evidence, dispatch, dispatchBefore, originalReceipt: jsonValue(raw) });
  };
  for (const row of active.values()) {
    if (!decoded.has(row.sourceKey)) continue;
    const value = decoded.get(row.sourceKey);
    if (row.sourceArea === "watch-state" && !holdActions.has(row.sourceKey)) {
      const parsed = WatchSchema.safeParse(value);
      if (!parsed.success) continue;
      row.classification = "checkpoint"; const watch = parsed.data;
      const originalDelivered: Record<string, unknown> = object(value) && object(value.delivered) ? value.delivered : {};
      result.checkpoints.push({ sourceKey: row.sourceKey, type: "answer-cursor", value: jsonValue({ cursor: watch.cursor }) }, { sourceKey: row.sourceKey, type: "claim-cursor", value: jsonValue({ claimsSince: watch.claimsSince ?? watch.cursor, ...(watch.prunedThrough ? { prunedThrough: watch.prunedThrough } : {}), delivered: watch.claimDelivered ?? {} }) }, { sourceKey: row.sourceKey, type: "task-steps", value: jsonValue(watch.tasks) }, { sourceKey: row.sourceKey, type: "task-closed", value: jsonValue(watch.taskClosed ?? {}) });
      if (watch.chatReceipt) result.checkpoints.push({ sourceKey: row.sourceKey, type: "chat-receipt", value: watch.chatReceipt });
      for (const answer of rawAnswers) {
        const item = records.get(answer.cardKey)!.record; const receipt = watch.delivered[answer.row.sourceKey];
        const names = new Set([item.from, ...(answer.value.action === "code" ? [] : ["xo"]), ...(receipt?.done ?? [])]);
        for (const name of names) {
          const key = parseKey(answer.row.sourceKey);
          const sent = receipt?.done.includes(name) || receipt?.complete || (key?.area === "answer" && key.at <= watch.cursor);
          appendDelivery(row.sourceKey, answer.row.sourceKey, name, sent ? "unconfirmed" : "pending", sent ? receipt?.done.includes(name) ? "sent-without-confirmation" : "historical-cursor" : "explicit", originalDelivered[answer.row.sourceKey] ?? { cursor: watch.cursor });
        }
      }
      for (const spec of eventSpecs.filter((event) => event.kind === "note" || (event.kind === "state" && event.eventKey.startsWith("done:")))) {
        const receipt = watch.delivered[spec.eventKey];
        const card = records.get(spec.cardKey)!.record;
        const names = new Set([...(eventRecipients.get(spec.eventKey) ?? []), ...(receipt?.done ?? [])]);
        for (const name of names) appendDelivery(row.sourceKey, spec.eventKey, name, receipt?.complete || receipt?.done.includes(name) || (spec.eventKey.startsWith("done:") && watch.taskClosed?.[card.id]) ? "unconfirmed" : "pending", receipt?.done.includes(name) ? "sent-without-confirmation" : "explicit", originalDelivered[spec.eventKey] ?? { done: [], complete: false });
      }
      for (const event of eventSpecs.filter((event) => event.kind === "claim")) {
        const deliveredAt = watch.claimDelivered?.[event.eventKey];
        const historical = Boolean(deliveredAt) || Date.parse(event.at) <= Date.parse(watch.claimsSince ?? watch.cursor) || Boolean(watch.prunedThrough && Date.parse(event.at) <= Date.parse(watch.prunedThrough));
        appendDelivery(row.sourceKey, event.eventKey, "Monica", historical ? "unconfirmed" : "pending", deliveredAt ? "sent-without-confirmation" : historical ? "historical-cursor" : "explicit", { deliveredAt: deliveredAt ?? null, claimsSince: watch.claimsSince ?? watch.cursor, prunedThrough: watch.prunedThrough ?? null }, deliveredAt);
      }
    } else if (holdActions.has(row.sourceKey)) {
      const state = holdActions.get(row.sourceKey)!;
      for (const [eventKey, receipt] of Object.entries(state.acted)) {
        const spec = eventSpecs.find((event) => event.eventKey === eventKey && event.kind === "state");
        if (spec) for (const name of recipients(records.get(spec.cardKey)!.record)) appendDelivery(row.sourceKey, eventKey, name, "unconfirmed", "sent-without-confirmation", receipt, receipt.at);
      }
      for (const [eventKey, notice] of Object.entries(state.owed)) appendDelivery(row.sourceKey, eventKey, notice.to, notice.sending ? "unconfirmed" : "pending", notice.sending ? "sent-without-confirmation" : "explicit", notice, notice.at);
    } else if (row.sourceArea === "expiry-state") {
      const parsed = ExpirySchema.safeParse(value);
      if (!parsed.success) { quarantine(row, "invalid", "Invalid expiry grace/checkpoint"); continue; }
      row.classification = "checkpoint"; result.checkpoints.push({ sourceKey: row.sourceKey, type: "expiry-grace", value: jsonValue(parsed.data) });
      if (parsed.data.owed) result.checkpoints.push({ sourceKey: row.sourceKey, type: "expiry-notice", value: jsonValue(parsed.data.owed) });
    } else if (row.sourceArea === "thread-watch-state") {
      const parsed = ThreadWatchSchema.safeParse(value);
      if (!parsed.success) { quarantine(row, "invalid", "Invalid thread watcher checkpoint"); continue; }
      row.classification = "checkpoint"; result.checkpoints.push({ sourceKey: row.sourceKey, type: "thread-cursor", value: jsonValue(parsed.data) });
      for (const [eventKey, attempt] of Object.entries(parsed.data.attempts)) appendDelivery(row.sourceKey, eventKey, attempt.recipient, attempt.state === "claimed" ? "unconfirmed" : attempt.state === "waiting" ? attempt.reason ? "held" : "pending" : attempt.state, "explicit", object(value) && object(value.attempts) ? value.attempts[eventKey] : attempt, attempt.at, attempt.routedTo);
    } else if (row.sourceKey.startsWith(`${source.namespace}board/watch/thread/`)) {
      const parsed = AttemptSchema.safeParse(value);
      const match = /\/thread\/([^/]+)\/([^/]+)\/([^/]+)\.json$/.exec(row.sourceKey);
      if (!parsed.success || !match) { quarantine(row, "unsupported-receipt", "Unsupported thread receipt retained without dispatch"); continue; }
      row.classification = "receipt";
      const thread = result.threads.find((entry) => entry.message.kind === match[1] && entry.message.id === match[2] && entry.message.messageId === match[3]);
      if (thread) appendDelivery(row.sourceKey, thread.sourceKey, parsed.data.recipient, parsed.data.state === "claimed" ? "unconfirmed" : parsed.data.state === "waiting" ? parsed.data.reason ? "held" : "pending" : parsed.data.state, "explicit", value, parsed.data.updatedAt, parsed.data.routedTo);
    }
  }
  // No checkpoint is not evidence of pending delivery: historical events fail closed.
  for (const event of result.ownerResponses) {
    if (result.deliveries.some((delivery) => delivery.eventKey === event.eventKey)) continue;
    const names = eventRecipients.get(event.eventKey) ?? [];
    for (const name of names) appendDelivery(event.sourceKey, event.eventKey, name, "held", "historical-cursor", { reason: "No trustworthy historical delivery checkpoint" });
  }
  const byRecipient = new Map<string, PreparedDelivery[]>();
  for (const delivery of result.deliveries) {
    const key = JSON.stringify([delivery.responseId, delivery.recipientKey]);
    const rows = byRecipient.get(key) ?? [];
    rows.push(delivery); byRecipient.set(key, rows);
  }
  for (const rows of byRecipient.values()) {
    if (new Set(rows.map((row) => JSON.stringify([row.state, row.routedTo, row.dispatchBefore]))).size < 2) continue;
    for (const row of rows) { row.dispatch = "never"; row.reason = "Conflicting historical delivery evidence; not dispatchable"; }
  }
  for (const row of active.values()) if (row.classification === "quarantine" && !result.quarantine.some((entry) => entry.sourceKey === row.sourceKey)) quarantine(row, "unknown", "Unknown source bytes preserved owner-only, not claimed as supported");
  result.sourceRows = [...archive.values()];
  return result;
}

/** Read owner-only projections without exposing raw archive bytes to agent outputs. */
export function ownerDataFromPreparedBundle(input: unknown): SitrepOwnerData {
  if (!object(input) || input.formatVersion !== 1 || input.modelVersion !== 1 || !Array.isArray(input.ownerState) || !Array.isArray(input.ownerResponses) || !Array.isArray(input.threads) || !Array.isArray(input.deliveries) || !Array.isArray(input.sourceRows) || !Array.isArray(input.cards) || !Array.isArray(input.deletions)) throw new Error("Invalid prepared owner bundle");
  const owner = emptySitrepOwnerData();
  const rawRows = new Map<string, Record<string, unknown>>();
  for (const row of input.sourceRows) {
    if (!object(row) || typeof row.sourceKey !== "string" || typeof row.rawBase64 !== "string") throw new Error("Invalid owner archive source reference");
    rawRows.set(row.sourceKey, row);
  }
  const decoded = new Map<string, unknown>();
  const sourceValue = (key: string): unknown => {
    if (decoded.has(key)) return decoded.get(key);
    const row = rawRows.get(key);
    if (!row) throw new Error("Owner projection source is missing");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(String(row.rawBase64)), (char) => char.charCodeAt(0)))); }
    catch { if (row.classification !== "quarantine") throw new Error("Invalid supported owner archive JSON"); }
    decoded.set(key, value); return value;
  };
  const deleted = new Set(input.deletions.flatMap((row) => object(row) && typeof row.sourceKey === "string" ? [row.sourceKey] : []));
  // Preserve all valid original answers, including an issuance with no canonical
  // response binding. Transport sequence and restoration admission are unrelated.
  for (const [sourceKey, row] of rawRows) {
    const key = parseKey(sourceKey);
    if (key?.area !== "answer") continue;
    const parsed = validateAnswer(sourceValue(sourceKey));
    if (!parsed.ok) { if (row.classification === "answer") throw new Error("Invalid archived domain answer"); continue; }
    if (parsed.value.askId !== key.askId || Date.parse(parsed.value.at) !== Date.parse(key.at)) throw new Error("Archived answer does not match its original source identity");
    const matches = input.cards.filter((card) => object(card) && object(card.record) && (card.record.kind === "ask" || card.record.kind === "approval") && card.record.id === key.askId);
    if (matches.length !== 1) continue;
    const card = matches[0];
    if (!object(card) || !object(card.record) || (card.record.kind !== "ask" && card.record.kind !== "approval") || typeof card.record.id !== "string") throw new Error("Invalid archived answer card");
    owner.answers.push({ sourceKey, card: { kind: card.record.kind, id: card.record.id }, value: parsed.value });
  }
  for (const row of input.ownerResponses) {
    if (!object(row) || typeof row.sourceKey !== "string" || typeof row.eventKey !== "string" || !object(row.response) || typeof row.response.responseId !== "string") throw new Error("Invalid prepared response provenance");
    (owner.responseOrigins ??= {})[row.response.responseId] = { sourceKey: row.sourceKey, eventKey: row.eventKey };
    if (row.ownerEventKind === "note") {
      if (!object(row.payload) || row.payload.type !== "sitrep.note" || row.payload.version !== 1 || !object(row.card) || typeof row.card.kind !== "string" || !isKind(row.card.kind) || typeof row.card.id !== "string" || !Array.isArray(row.recipientKeys) || !row.recipientKeys.every((key) => typeof key === "string") || !Array.isArray(row.unresolvedRecipients) || !row.unresolvedRecipients.every((name) => typeof name === "string")) throw new Error("Invalid legacy outbound note");
      const note = decodeLegacySendNote({ kind: row.card.kind, id: row.card.id }, row.payload.data);
      if (note.sourceKey !== row.sourceKey || note.eventKey !== row.eventKey) throw new Error("Legacy send-note provenance does not match its envelope");
      (owner.outboundNotes ??= []).push({ type: "note", sourceKey: row.sourceKey, eventKey: row.eventKey, responseId: row.response.responseId, card: { kind: note.kind, id: note.id }, at: note.at, text: note.text, recipientKeys: row.recipientKeys as string[], unresolvedRecipients: row.unresolvedRecipients as string[] });
    }
    if (row.ownerEventKind === "hold-notice") {
      if (!object(row.payload) || row.payload.type !== "sitrep.hold-notice" || row.payload.version !== 1 || !object(row.payload.data) || !object(row.card) || row.card.kind !== "hold" || typeof row.card.id !== "string" || !Array.isArray(row.recipientKeys) || !row.recipientKeys.every((key) => typeof key === "string") || !Array.isArray(row.unresolvedRecipients) || !row.unresolvedRecipients.every((name) => typeof name === "string")) throw new Error("Invalid legacy hold notice");
      const data = row.payload.data;
      if (data.noticeKey !== row.eventKey || typeof data.at !== "string" || !Number.isFinite(Date.parse(data.at)) || typeof data.line !== "string") throw new Error("Invalid legacy notice identity");
      (owner.outboundNotes ??= []).push({ type: "hold-notice", sourceKey: row.sourceKey, eventKey: row.eventKey, responseId: row.response.responseId, card: { kind: "hold", id: row.card.id }, at: data.at, text: data.line, recipientKeys: row.recipientKeys as string[], unresolvedRecipients: row.unresolvedRecipients as string[] });
    }
    if (row.ownerEventKind === "thread") {
      if (!object(row.payload) || row.payload.type !== "sitrep.thread" || row.payload.version !== 1 || !object(row.card) || typeof row.card.kind !== "string" || !isKind(row.card.kind) || typeof row.card.id !== "string") throw new Error("Invalid prepared owner thread event");
      const { message } = decodeOwnerThreadMessage({ kind: row.card.kind, id: row.card.id }, row.payload.data);
      (owner.threadResponses ??= {})[ownerThreadResponseKey(message)] = row.response.responseId;
    }
  }
  for (const row of input.ownerState) {
    if (!object(row) || typeof row.sourceKey !== "string" || deleted.has(row.sourceKey)) throw new Error("Invalid prepared owner state source");
    const raw = sourceValue(row.sourceKey);
    if (row.type === "state") {
      const parsed = validateState(row.value); const original = validateState(raw);
      if (!parsed.ok || !original.ok || JSON.stringify(parsed.value) !== JSON.stringify(original.value)) throw new Error("Imported owner state does not match frozen bytes");
      const state = { ...parsed.value };
      if (LEGACY_NOTE_KINDS.has(state.kind)) delete state.notes;
      owner.states.push(state);
    } else if (row.type === "claim-decision") {
      const parsed = validateClaimDecision(row.value); const original = validateClaimDecision(raw);
      if (!parsed.ok || !original.ok || JSON.stringify(parsed.value) !== JSON.stringify(original.value) || !object(row.card) || row.card.kind !== "claim" || typeof row.card.id !== "string") throw new Error("Invalid imported claim decision");
      owner.claimDecisions.push({ sourceKey: row.sourceKey, card: { kind: "claim", id: row.card.id }, value: parsed.value });
    } else if (row.type === "group-preference") {
      const parsed = validateGroupPriority(row.value); const original = validateGroupPriority(raw);
      if (!parsed.ok || !original.ok || JSON.stringify(parsed.value) !== JSON.stringify(original.value)) throw new Error("Invalid imported group preference");
      owner.groupPriority = parsed.value;
    } else throw new Error("Unsupported prepared owner state");
  }
  for (const row of input.threads) {
    if (!object(row) || typeof row.sourceKey !== "string") throw new Error("Invalid prepared thread");
    const parsed = parseThreadMessage(row.sourceKey, sourceValue(row.sourceKey));
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(row.message)) throw new Error("Imported thread does not match its immutable frozen source");
    owner.threads.push(parsed);
    (owner.threadOrigins ??= {})[ownerThreadResponseKey(parsed)] = { kind: "legacy", sourceKey: row.sourceKey };
  }
  for (const value of input.deliveries) {
    if (!object(value) || typeof value.sourceKey !== "string" || typeof value.responseId !== "string" || typeof value.recipientKey !== "string" || typeof value.recipient !== "string" || !["pending", "held", "delivered", "unconfirmed", "refused"].includes(String(value.state)) || !["never", "held", "resolved-pending"].includes(String(value.dispatch))) throw new Error("Invalid prepared delivery receipt");
    if ((value.state === "delivered" || value.state === "unconfirmed" || value.state === "refused") && value.dispatch !== "never") throw new Error("Historical terminal delivery cannot become dispatchable");
    if (!Object.hasOwn(value, "dispatchBefore") || (value.dispatchBefore !== null && (typeof value.dispatchBefore !== "string" || !Number.isFinite(Date.parse(value.dispatchBefore))))) throw new Error("Prepared delivery requires an explicit valid execution cutoff");
    if (value.dispatch === "resolved-pending" && value.state !== "pending") throw new Error("Only a pending event can receive pending authority");
    owner.deliveries.push(value as unknown as PreparedDelivery);
  }
  owner.states = mergeSitrepStates(owner.states);
  return owner;
}
