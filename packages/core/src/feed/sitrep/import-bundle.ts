import type { Answer, BoardRecord, ClaimDecision, GroupPriority, Kind, SamState } from "./schema";
import type { ThreadMessage } from "./card-thread";
import type { SitrepCardPayload } from "./model-types";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface ModelSourceOrigin {
  path: string;
  sha256: string;
}

export interface PreparedSourceOrigin {
  spaceId: string;
  namespace: string;
  snapshotId: string;
  completePrefixSnapshot: boolean;
  /** Causal data reference, derived only from the supplied previous frozen bundle. */
  previousSnapshotId?: string;
  cursor?: JSONValue;
  revision?: JSONValue;
}

export interface LegacyCardRef {
  kind: Kind;
  id: string;
}

export interface PreparedCardIdentity {
  cardId: string;
  revision: number;
  issuanceId: string;
}

export type SourceClassification = "card" | "answer" | "owner-state" | "claim-decision" | "group-preference" | "thread" | "receipt" | "checkpoint" | "quarantine";

/** Every raw source value is archived only in owner-controlled storage. */
export interface PreparedSourceRow {
  sourceKey: string;
  sourceArea: "kv" | "watch-state" | "thread-watch-state" | "expiry-state";
  encoding: "base64";
  rawBase64: string;
  sha256: string;
  classification: SourceClassification;
}

/** Authenticated publishers are not logical officer names or delivery recipients. */
export interface PreparedPublisher {
  publisherId: string;
  agentId: string;
  agentDid: string;
  outputResource: string;
  responseResource: string;
}

export interface PreparedRecipient {
  recipientKey: string;
  legacyName: string;
  runtimeTarget?: { agentId: string; provider?: string };
}

export interface PreparedRoute {
  sourceKey: string;
  card: LegacyCardRef;
  recipientKeys: string[];
  fallbackRecipientKeys: string[];
  unresolvedRecipients: string[];
}

export interface PreparedCanonicalCard extends PreparedCardIdentity {
  kind: string;
  needsResponse: boolean;
  title: string;
  body: string;
  choices?: { id: string; label: string }[];
  urgency: number;
  createdAt: string;
  payload: {
    sitrep: SitrepCardPayload;
    source: { label: string; ref: string };
    report?: { label: string; url: string };
    project?: string;
  };
}

/** Already-resolved domain data. Importers must not run legacy projections. */
export interface PreparedCard {
  sourceKey: string;
  publisherId: string;
  identity: PreparedCardIdentity;
  record: BoardRecord;
  canonicalCard: PreparedCanonicalCard;
  needsAction: boolean;
  currentAnswerSourceKey?: string;
  foldedInto?: LegacyCardRef;
  attention: "needs-action" | "information" | "handled" | "expired" | "snoozed" | "closed" | "not-needed" | "waiting-on-owner";
}

export interface PreparedPrivatePayload {
  type: string;
  version: number;
  data: JSONValue;
}

/** Safe response header; private approval text belongs only in payload. */
export interface PreparedResponseHeader extends PreparedCardIdentity {
  responseId: string;
  kind: "answer" | "followup" | "message";
  choiceId?: string;
  text?: string;
  supersedesResponseId?: string;
  createdAt: string;
}

export interface PreparedOwnerResponse {
  sourceKey: string;
  /** Captured watcher event identity; sourceKey remains the actual raw KV/sidecar key. */
  eventKey: string;
  publisherId: string;
  card: LegacyCardRef;
  response: PreparedResponseHeader;
  payload?: PreparedPrivatePayload;
  ownerEventKind: "answer" | "state" | "claim" | "thread" | "note" | "hold-notice";
  /** Present only for actual domain answers; transport order never answers a card. */
  legacyAnswer?: Answer;
  /** Unresolved intended destinations remain in the owner archive, not agent-readable responses. */
  restoreTarget: "agent-response" | "owner-only";
  recipientKeys: string[];
  unresolvedRecipients: string[];
}

export type PreparedOwnerState =
  | { sourceKey: string; type: "state"; value: SamState }
  | { sourceKey: string; type: "claim-decision"; card: LegacyCardRef; value: ClaimDecision }
  | { sourceKey: string; type: "group-preference"; value: GroupPriority };

export interface PreparedThread {
  sourceKey: string;
  publisherId: string;
  identity: PreparedCardIdentity;
  message: ThreadMessage;
}

export interface PreparedDelivery {
  sourceKey: string;
  eventSourceKey: string;
  eventKey: string;
  publisherId: string;
  identity: PreparedCardIdentity;
  responseId: string;
  recipientKey: string;
  /** Original logical recipient spelling, not an authenticated publisher identity. */
  recipient: string;
  state: "pending" | "held" | "delivered" | "unconfirmed" | "refused";
  routedTo: "owner" | "xo";
  at?: string;
  reason?: string;
  /** A legacy sent/unconfirmed-conflated ledger must not fabricate delivery. */
  evidence: "explicit" | "sent-without-confirmation" | "historical-cursor";
  dispatch: "never" | "resolved-pending" | "held";
  /** Explicit null means the captured runtime has genuinely no absolute execution cutoff. */
  dispatchBefore: string | null;
  originalReceipt: JSONValue;
}

export interface PreparedCheckpoint {
  sourceKey: string;
  type: "answer-cursor" | "claim-cursor" | "task-steps" | "task-closed" | "thread-cursor" | "expiry-grace" | "expiry-notice" | "chat-receipt" | "hold-actions";
  value: JSONValue;
}

/** Source deletion is retained, not a command to erase append-only answers. */
export interface PreparedDeletion {
  sourceKey: string;
  classification: SourceClassification;
  previousSha256?: string;
  deletedAt?: string;
}

export interface PreparedQuarantine {
  sourceKey: string;
  reason: "unknown" | "invalid" | "ambiguous-reference" | "orphan-reference" | "unmapped-publisher" | "unresolved-issuance" | "unsupported-receipt";
  detail: string;
}

export interface PreparedSitrepImportBundle {
  formatVersion: 1;
  modelVersion: 1;
  frozenAt: string;
  source: PreparedSourceOrigin;
  origins: ModelSourceOrigin[];
  sourceRows: PreparedSourceRow[];
  publishers: PreparedPublisher[];
  recipients: PreparedRecipient[];
  routes: PreparedRoute[];
  cards: PreparedCard[];
  ownerResponses: PreparedOwnerResponse[];
  ownerState: PreparedOwnerState[];
  threads: PreparedThread[];
  deliveries: PreparedDelivery[];
  checkpoints: PreparedCheckpoint[];
  deletions: PreparedDeletion[];
  quarantine: PreparedQuarantine[];
}

export interface SitrepImportPublisherBinding {
  sourceKey: string;
  publisherId: string;
  identity: PreparedCardIdentity;
}

export interface PrepareSitrepImportInput {
  source: PreparedSourceOrigin;
  frozenAt: string;
  rows: Omit<PreparedSourceRow, "classification">[];
  publishers: PreparedPublisher[];
  publisherBindings: SitrepImportPublisherBinding[];
  recipients: PreparedRecipient[];
  deletions?: PreparedDeletion[];
  previous?: PreparedSitrepImportBundle;
}
