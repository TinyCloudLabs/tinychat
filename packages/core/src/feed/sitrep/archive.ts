import { parseKey, validateRecord, validateAnswer, validateClaimDecision, validateState } from "./schema";
import { parseThreadMessage, threadPrefix, type ThreadMessage } from "./card-thread";
import { jsonValue, ownerDataFromPreparedBundle } from "./prepare-import";
import type { BoardRecord } from "./schema";
import type { PreparedCardIdentity, PreparedSitrepImportBundle, PreparedOwnerResponse, PreparedRecipient } from "./import-bundle";
import { importedExecutionWindow, hasCapturedPendingEvidence } from "./delivery-window";
import { safeSitrepActionSummary } from "./model";
import { SITREP_MODEL_ORIGINS } from "./origins";
import { decodeLegacySendNote } from "./legacy-notes";
import { prepareEventRecipients } from "./prepared-recipients";

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
export function validPreparedIdentity(value: unknown): value is PreparedCardIdentity {
  return object(value) && typeof value.cardId === "string" && value.cardId.length > 0 && typeof value.issuanceId === "string" && value.issuanceId.length > 0 && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision > 0;
}

/** Versioned owner archive verification. No source access, grant inference or dispatch. */
export async function validatePreparedOwnerArchive(input: unknown): Promise<PreparedSitrepImportBundle> {
  jsonValue(input);
  if (!object(input) || input.formatVersion !== 1 || input.modelVersion !== 1 || typeof input.frozenAt !== "string" || !Number.isFinite(Date.parse(input.frozenAt)) || !object(input.source)) throw new Error("Unsupported prepared Home archive");
  const source = input.source;
  if (typeof source.spaceId !== "string" || !source.spaceId || typeof source.namespace !== "string" || !source.namespace.endsWith("/") || typeof source.snapshotId !== "string" || !source.snapshotId || typeof source.completePrefixSnapshot !== "boolean") throw new Error("Invalid frozen archive source identity");
  if (source.previousSnapshotId !== undefined && (typeof source.previousSnapshotId !== "string" || !source.previousSnapshotId || source.previousSnapshotId === source.snapshotId)) throw new Error("Invalid frozen archive causal predecessor");
  for (const key of ["origins", "sourceRows", "publishers", "recipients", "routes", "cards", "ownerResponses", "ownerState", "threads", "deliveries", "checkpoints", "deletions", "quarantine"]) if (!Array.isArray(input[key])) throw new Error(`Missing archive ${key}`);
  const sourceKeys = new Set<string>();
  const rawValues = new Map<string, unknown>();
  const sourceAreas = new Map<string, string>();
  const records = new Map<string, BoardRecord>();
  for (const row of input.sourceRows as unknown[]) {
    if (!object(row) || typeof row.sourceKey !== "string" || sourceKeys.has(row.sourceKey) || row.encoding !== "base64" || typeof row.rawBase64 !== "string" || typeof row.sha256 !== "string" || !["kv", "watch-state", "thread-watch-state", "expiry-state"].includes(String(row.sourceArea))) throw new Error("Invalid archived source row");
    if (row.sourceArea === "kv" && !row.sourceKey.startsWith(source.namespace)) throw new Error("Archived source row is outside its namespace");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.rawBase64)) throw new Error("Invalid archived base64 bytes");
    const bytes = Uint8Array.from(atob(row.rawBase64), (char) => char.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hex !== row.sha256) throw new Error("Archived source bytes do not match their digest");
    if (!["card", "answer", "owner-state", "claim-decision", "group-preference", "thread", "receipt", "checkpoint", "quarantine"].includes(String(row.classification))) throw new Error("Unknown archived source classification");
    try { rawValues.set(row.sourceKey, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { if (row.classification !== "quarantine") throw new Error("Supported archive source is not valid UTF-8 JSON"); }
    sourceKeys.add(row.sourceKey);
    sourceAreas.set(row.sourceKey, String(row.sourceArea));
  }
  for (const origin of input.origins as unknown[]) if (!object(origin) || typeof origin.path !== "string" || origin.path.startsWith("/") || origin.path.split("/").includes("..") || typeof origin.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(origin.sha256)) throw new Error("Invalid relative model provenance");
  const origins = new Map((input.origins as Record<string, unknown>[]).map((origin) => [origin.path, origin.sha256]));
  if (origins.size !== SITREP_MODEL_ORIGINS.length || (input.origins as unknown[]).length !== origins.size || SITREP_MODEL_ORIGINS.some((origin) => origins.get(origin.path) !== origin.sha256)) throw new Error("Unsupported model source provenance");
  const publisherIds = new Set<string>(); const tokens = new Set<string>(); const leaves = new Set<string>();
  for (const publisher of input.publishers as unknown[]) {
    if (!object(publisher) || ![publisher.publisherId, publisher.agentId, publisher.agentDid, publisher.outputResource, publisher.responseResource].every((value) => typeof value === "string" && value.length)) throw new Error("Invalid archived publisher mapping");
    const id = String(publisher.publisherId); const token = String(publisher.agentId);
    if (publisherIds.has(id) || tokens.has(token)) throw new Error("Ambiguous archived publisher mapping");
    publisherIds.add(id); tokens.add(token);
    for (const resource of [String(publisher.outputResource), String(publisher.responseResource)]) { const leaf = resource.split("/").at(-1)!; if (!resource.includes("/") || !leaf || leaves.has(leaf)) throw new Error("Ambiguous archived resource leaf"); leaves.add(leaf); }
  }
  const recipients = new Set<string>();
  for (const recipient of input.recipients as unknown[]) {
    if (!object(recipient) || typeof recipient.recipientKey !== "string" || !recipient.recipientKey || typeof recipient.legacyName !== "string" || recipients.has(recipient.recipientKey)) throw new Error("Invalid archived logical recipient");
    if (recipient.runtimeTarget !== undefined && (!object(recipient.runtimeTarget) || typeof recipient.runtimeTarget.agentId !== "string" || !recipient.runtimeTarget.agentId)) throw new Error("Invalid explicit recipient runtime mapping");
    recipients.add(recipient.recipientKey);
  }
  const identities = new Set<string>();
  for (const card of input.cards as unknown[]) {
    if (!object(card) || typeof card.sourceKey !== "string" || !sourceKeys.has(card.sourceKey) || typeof card.publisherId !== "string" || !publisherIds.has(card.publisherId) || !validPreparedIdentity(card.identity) || !object(card.record)) throw new Error("Invalid archived card binding");
    const key = parseKey(card.sourceKey);
    if (key?.area !== "board") throw new Error("Archived card key is not a typed board key");
    const parsed = validateRecord(key.kind, card.record);
    if (!parsed.ok || parsed.value.kind !== key.kind || parsed.value.id !== key.id) throw new Error("Archived card does not match its full source key");
    const raw = validateRecord(key.kind, rawValues.get(card.sourceKey));
    if (!raw.ok || JSON.stringify(raw.value) !== JSON.stringify(parsed.value)) throw new Error("Typed card projection does not match its frozen source bytes");
    records.set(`${key.kind}:${key.id}`, parsed.value);
    const identity = JSON.stringify([card.publisherId, card.identity.cardId, card.identity.revision, card.identity.issuanceId]);
    if (identities.has(identity)) throw new Error("Ambiguous archived card identity"); identities.add(identity);
    if (Object.keys(card.identity).some((key) => !["cardId", "revision", "issuanceId"].includes(key))) throw new Error("Unexpected canonical identity field");
    const canonical = card.canonicalCard;
    if (!object(canonical) || !validPreparedIdentity(canonical) || canonical.cardId !== card.identity.cardId || canonical.revision !== card.identity.revision || canonical.issuanceId !== card.identity.issuanceId || canonical.kind !== key.kind || canonical.title !== parsed.value.title || canonical.body !== parsed.value.body || typeof canonical.needsResponse !== "boolean" || typeof canonical.urgency !== "number" || !Number.isFinite(canonical.urgency) || canonical.createdAt !== parsed.value.createdAt || !object(canonical.payload)) throw new Error("Archived output projection does not match its validated record and identity");
    if (Object.keys(canonical).some((key) => !["cardId", "revision", "issuanceId", "kind", "needsResponse", "title", "body", "choices", "urgency", "createdAt", "payload"].includes(key))) throw new Error("Unexpected canonical card field");
    const payload = canonical.payload;
    if (Object.keys(payload).some((key) => !["sitrep", "source", "report", "project"].includes(key)) || !object(payload.sitrep) || payload.sitrep.version !== 1 || JSON.stringify(payload.sitrep.record) !== JSON.stringify(card.record) || !object(payload.source) || payload.source.ref !== card.sourceKey || typeof payload.source.label !== "string") throw new Error("Unsafe or missing prebuilt typed card payload");
    if (payload.report !== undefined) {
      const report = payload.report;
      if (!object(report) || typeof report.label !== "string" || typeof report.url !== "string" || !parsed.value.links.some((link) => link.url === report.url && link.label === report.label)) throw new Error("Report projection is not source-backed");
    }
    if (payload.project !== undefined && payload.project !== parsed.value.repo) throw new Error("Project projection is not source-backed");
    if (canonical.choices !== undefined && (!Array.isArray(canonical.choices) || parsed.value.kind !== "ask" || JSON.stringify(canonical.choices) !== JSON.stringify(parsed.value.options.map(({ id, label }) => ({ id, label }))))) throw new Error("Canonical choices do not match the typed question");
  }
  for (const route of input.routes as unknown[]) if (!object(route) || typeof route.sourceKey !== "string" || !sourceKeys.has(route.sourceKey) || !strings(route.recipientKeys) || !strings(route.fallbackRecipientKeys) || !strings(route.unresolvedRecipients) || [...route.recipientKeys, ...route.fallbackRecipientKeys].some((key) => !recipients.has(key))) throw new Error("Invalid archived recipient route");
  const responseIds = new Set<string>();
  const eventIds = new Set<string>();
  const events = new Map<string, Record<string, unknown>>();
  for (const event of input.ownerResponses as unknown[]) {
    if (!object(event) || typeof event.sourceKey !== "string" || !sourceKeys.has(event.sourceKey) || typeof event.eventKey !== "string" || !event.eventKey || typeof event.publisherId !== "string" || !publisherIds.has(event.publisherId) || !object(event.response) || !validPreparedIdentity(event.response) || typeof event.response.responseId !== "string" || !event.response.responseId || responseIds.has(event.response.responseId) || eventIds.has(event.eventKey) || !["answer", "state", "claim", "thread", "note", "hold-notice"].includes(String(event.ownerEventKind))) throw new Error("Invalid archived owner event identity");
    const header = event.response;
    const responseId = header.responseId;
    if (typeof responseId !== "string" || !responseId) throw new Error("Invalid prepared response identity");
    if (!["answer", "followup", "message"].includes(String(header.kind)) || typeof header.createdAt !== "string" || !Number.isFinite(Date.parse(header.createdAt)) || Object.keys(header).some((key) => !["cardId", "revision", "issuanceId", "responseId", "kind", "choiceId", "text", "supersedesResponseId", "createdAt"].includes(key)) || (header.text !== undefined && typeof header.text !== "string") || (header.choiceId !== undefined && (typeof header.choiceId !== "string" || !header.choiceId)) || (header.supersedesResponseId !== undefined && (typeof header.supersedesResponseId !== "string" || !header.supersedesResponseId))) throw new Error("Invalid prepared response header");
    if (header.kind === "message" && (header.choiceId !== undefined || header.supersedesResponseId !== undefined || typeof header.text !== "string" || !header.text)) throw new Error("Messages cannot answer or supersede a question");
    if ((event.ownerEventKind === "answer" || event.ownerEventKind === "claim") !== (header.kind !== "message")) throw new Error("Domain response and message discriminants disagree");
    if (!strings(event.recipientKeys) || !strings(event.unresolvedRecipients) || new Set(event.recipientKeys).size !== event.recipientKeys.length || event.recipientKeys.some((key) => !recipients.has(key)) || !["agent-response", "owner-only"].includes(String(event.restoreTarget))) throw new Error("Unresolved prepared response destination");
    if (event.restoreTarget === "agent-response" && !event.recipientKeys.some((key) => (input.recipients as Record<string, unknown>[]).some((recipient) => recipient.recipientKey === key && object(recipient.runtimeTarget)))) throw new Error("Private owner event has no approved runtime destination");
    if (!object(event.card)) throw new Error("Owner event has no typed card reference");
    const eventCard = event.card;
    if (!(input.cards as Record<string, unknown>[]).some((card) => object(card.record) && card.record.kind === eventCard.kind && card.record.id === eventCard.id)) throw new Error("Owner event has no typed card reference");
    if (!object(event.payload) || event.payload.version !== 1 || typeof event.payload.type !== "string") throw new Error("Missing prepared typed owner event");
    if (event.ownerEventKind === "answer") {
      const answer = validateAnswer(event.legacyAnswer);
      if (!answer.ok || answer.value.askId !== event.card.id || event.payload.type !== "sitrep.answer" || JSON.stringify(event.payload.data) !== JSON.stringify(event.legacyAnswer)) throw new Error("Invalid archived domain answer");
      const raw = validateAnswer(rawValues.get(event.sourceKey));
      if (!raw.ok || JSON.stringify(raw.value) !== JSON.stringify(answer.value) || header.createdAt !== answer.value.at || event.eventKey !== event.sourceKey || header.text !== safeSitrepActionSummary({ type: "sitrep.answer", value: answer.value }) || header.choiceId !== undefined) throw new Error("Answer header or payload does not match its frozen source");
    } else if (event.legacyAnswer !== undefined) throw new Error("Non-answer event cannot supply a domain answer");
    if (event.ownerEventKind === "claim" && (event.payload.type !== "sitrep.claim" || event.card.kind !== "claim" || !validateClaimDecision(event.payload.data).ok)) throw new Error("Invalid archived claim decision");
    const raw = rawValues.get(event.sourceKey);
    const rawKey = parseKey(event.sourceKey);
    if (event.ownerEventKind === "claim") {
      const decision = validateClaimDecision(raw);
      if (rawKey?.area !== "claim-decision" || rawKey.id !== event.card.id || !decision.ok || JSON.stringify(decision.value) !== JSON.stringify(event.payload.data) || header.createdAt !== decision.value.at || header.text !== "Historical claim decision") throw new Error("Claim projection does not match its frozen source");
    }
    if (event.ownerEventKind === "note") {
      const record = records.get(`${event.card.kind}:${event.card.id}`)!;
      const note = decodeLegacySendNote(record, event.payload.data);
      const state = validateState(raw);
      if (!state.ok || note.sourceKey !== event.sourceKey || note.eventKey !== event.eventKey || !state.value.notes?.some((original) => original.id === note.noteId && original.at === note.at && original.text === note.text) || header.createdAt !== note.at || header.text !== "Historical explicit owner note") throw new Error("Legacy note is not present in its frozen raw state");
    }
    if (event.ownerEventKind === "thread") {
      const message = parseThreadMessage(event.sourceKey, raw);
      if (!message || message.side !== "sam" || event.payload.type !== "sitrep.thread" || JSON.stringify(message) !== JSON.stringify(event.payload.data) || header.createdAt !== message.at || header.text !== "Historical card message") throw new Error("Owner thread does not match its frozen source");
    }
    if (event.ownerEventKind === "hold-notice") {
      const data = event.payload.data;
      const notice = object(raw) && object(raw.owed) ? raw.owed[event.eventKey] : undefined;
      if (event.card.kind !== "hold" || event.payload.type !== "sitrep.hold-notice" || !object(data) || !object(notice) || data.noticeKey !== event.eventKey || data.to !== notice.to || data.line !== notice.line || data.at !== notice.at || header.createdAt !== notice.at || header.text !== "Historical hold notice") throw new Error("Hold notice does not match the frozen owed notice");
    }
    if (event.ownerEventKind === "state") {
      const state = validateState(event.payload.data);
      if (!state.ok || state.value.kind !== event.card.kind || state.value.id !== event.card.id || state.value.notes !== undefined || state.value.snoozes !== undefined || state.value.priority !== undefined || state.value.seenAt !== undefined || state.value.snoozedUntil !== undefined || state.value.dismissedAt !== undefined || Object.keys(state.value.steps).length || (!state.value.doneAt && !state.value.lift && !state.value.clears?.length)) throw new Error("Private owner state cannot be archived as an agent command");
      const original = validateState(raw);
      if (!original.ok || original.value.kind !== state.value.kind || original.value.id !== state.value.id || (state.value.doneAt && state.value.doneAt !== original.value.doneAt) || (state.value.lift && JSON.stringify(state.value.lift) !== JSON.stringify(original.value.lift)) || state.value.clears?.some((clear) => !original.value.clears?.some((candidate) => JSON.stringify(candidate) === JSON.stringify(clear))) || header.text !== "Historical owner command") throw new Error("Owner command does not match its frozen raw state");
    }
    responseIds.add(responseId); eventIds.add(event.eventKey); events.set(responseId, event);
    const record = records.get(`${eventCard.kind}:${eventCard.id}`);
    if (!record) throw new Error("Prepared owner event has no validated card");
    const route = prepareEventRecipients(record, event as unknown as PreparedOwnerResponse, input.recipients as unknown as PreparedRecipient[]);
    if (JSON.stringify(event.recipientKeys) !== JSON.stringify(route.recipientKeys) || JSON.stringify(event.unresolvedRecipients) !== JSON.stringify(route.unresolvedRecipients) || event.restoreTarget !== route.restoreTarget) throw new Error("Prepared recipients do not match the captured source rules and explicit catalog");
  }
  const policies = new Map<string, Record<string, unknown>[]>();
  for (const delivery of input.deliveries as unknown[]) {
    if (!object(delivery) || typeof delivery.sourceKey !== "string" || !sourceKeys.has(delivery.sourceKey) || typeof delivery.eventSourceKey !== "string" || !sourceKeys.has(delivery.eventSourceKey) || typeof delivery.eventKey !== "string" || typeof delivery.responseId !== "string" || typeof delivery.recipientKey !== "string" || !recipients.has(delivery.recipientKey) || !validPreparedIdentity(delivery.identity) || !["owner", "xo"].includes(String(delivery.routedTo)) || !Object.hasOwn(delivery, "dispatchBefore") || (delivery.dispatchBefore !== null && (typeof delivery.dispatchBefore !== "string" || !Number.isFinite(Date.parse(delivery.dispatchBefore))))) throw new Error("Invalid prepared delivery provenance or cutoff");
    const event = events.get(delivery.responseId);
    const header = event?.response;
    if (!event || !object(header) || event.sourceKey !== delivery.eventSourceKey || event.eventKey !== delivery.eventKey || event.publisherId !== delivery.publisherId || header.cardId !== delivery.identity.cardId || header.revision !== delivery.identity.revision || header.issuanceId !== delivery.identity.issuanceId) throw new Error("Delivery identity does not match its immutable owner event");
    const card = object(event.card) ? records.get(`${event.card.kind}:${event.card.id}`) : undefined;
    if (!card) throw new Error("Prepared delivery has no validated domain card");
    const window = importedExecutionWindow(card, event as unknown as PreparedOwnerResponse, input.frozenAt as string);
    if (delivery.dispatchBefore !== window.dispatchBefore || (delivery.dispatch === "resolved-pending" && (window.refusal || window.heldReason))) throw new Error("Prepared execution cutoff does not match the captured runtime rules");
    if (typeof delivery.recipient !== "string") throw new Error("Historical delivery lacks its original logical recipient");
    const recipient = (input.recipients as Record<string, unknown>[]).find((row) => row.recipientKey === delivery.recipientKey);
    const normalize = (name: string) => name.trim().replace(/^officer:/, "").toLowerCase();
    if (!recipient || normalize(String(recipient.legacyName)) !== normalize(delivery.recipient)) throw new Error("Historical recipient key does not match its explicit logical mapping");
    if (delivery.dispatch === "resolved-pending" && !hasCapturedPendingEvidence(card, event as unknown as PreparedOwnerResponse, delivery.recipient, rawValues.get(delivery.sourceKey), sourceAreas.get(delivery.sourceKey) ?? "")) throw new Error("Historical pending exception has no positive captured evidence");
    if (delivery.dispatch === "resolved-pending" && (delivery.state !== "pending" || event.restoreTarget !== "agent-response" || !(input.recipients as Record<string, unknown>[]).some((recipient) => recipient.recipientKey === delivery.recipientKey && object(recipient.runtimeTarget)) || (typeof delivery.dispatchBefore === "string" && Date.parse(delivery.dispatchBefore) <= Date.parse(input.frozenAt as string)))) throw new Error("Ineligible historical pending exception");
    const key = JSON.stringify([delivery.responseId, delivery.recipientKey]);
    const previous = policies.get(key) ?? [];
    if (previous.some((row) => (row.dispatch === "resolved-pending" || delivery.dispatch === "resolved-pending") && (row.state !== delivery.state || row.routedTo !== delivery.routedTo || row.dispatchBefore !== delivery.dispatchBefore || row.dispatch !== delivery.dispatch))) throw new Error("Conflicting historical pending authority");
    previous.push(delivery); policies.set(key, previous);
  }
  const deleted = new Set<string>();
  for (const deletion of input.deletions as unknown[]) {
    if (!object(deletion) || typeof deletion.sourceKey !== "string" || deleted.has(deletion.sourceKey) || (!deletion.sourceKey.startsWith(source.namespace) && !sourceKeys.has(deletion.sourceKey)) || typeof deletion.deletedAt !== "string" || !Number.isFinite(Date.parse(deletion.deletedAt)) || !["card", "answer", "owner-state", "claim-decision", "group-preference", "thread", "receipt", "checkpoint", "quarantine"].includes(String(deletion.classification)) || (deletion.previousSha256 !== undefined && (typeof deletion.previousSha256 !== "string" || !/^[0-9a-f]{64}$/.test(deletion.previousSha256)))) throw new Error("Invalid classified source deletion");
    deleted.add(deletion.sourceKey);
  }
  for (const checkpoint of input.checkpoints as unknown[]) if (!object(checkpoint) || typeof checkpoint.sourceKey !== "string" || !sourceKeys.has(checkpoint.sourceKey) || !["answer-cursor", "claim-cursor", "task-steps", "task-closed", "thread-cursor", "expiry-grace", "expiry-notice", "chat-receipt", "hold-actions"].includes(String(checkpoint.type))) throw new Error("Invalid classified source checkpoint");
  for (const quarantined of input.quarantine as unknown[]) if (!object(quarantined) || typeof quarantined.sourceKey !== "string" || !sourceKeys.has(quarantined.sourceKey) || typeof quarantined.detail !== "string" || !["unknown", "invalid", "ambiguous-reference", "orphan-reference", "unmapped-publisher", "unresolved-issuance", "unsupported-receipt"].includes(String(quarantined.reason))) throw new Error("Invalid preserved source quarantine");
  ownerDataFromPreparedBundle(input);
  // Every shape used by Home was checked above; optional opaque data remains JSON.
  return input as unknown as PreparedSitrepImportBundle;
}

export interface SitrepOfficerThreadEvent { version: 1; parent: PreparedCardIdentity; message: ThreadMessage }

/** The caller must first resolve parent against the SAME registered output source. */
export function parseOfficerThreadEvent(input: unknown, parent: BoardRecord): SitrepOfficerThreadEvent | null {
  if (!object(input) || input.version !== 1 || !validPreparedIdentity(input.parent) || !object(input.message)) return null;
  const message = input.message;
  if (message.side !== "officer" || typeof message.messageId !== "string" || message.kind !== parent.kind || message.id !== parent.id) return null;
  const { side: _side, messageId, ...body } = message;
  const parsed = parseThreadMessage(`${threadPrefix("officer", parent.kind, parent.id)}${messageId}.json`, body);
  return parsed ? { version: 1, parent: input.parent, message: parsed } : null;
}
