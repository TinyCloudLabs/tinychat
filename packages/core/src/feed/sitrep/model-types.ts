import type { Answer, ClaimDecision, GroupPriority, SamState, BoardRecord } from "./schema";
import type { ThreadMessage } from "./card-thread";
import type { LegacyCardRef, PreparedDelivery } from "./import-bundle";

export interface SitrepCardPayload {
  version: 1;
  record: BoardRecord;
}

export interface SitrepOwnerAnswer {
  sourceKey: string;
  card: LegacyCardRef;
  value: Answer;
}

export interface SitrepHeldNote {
  eventId: string;
  at: string;
  text: string;
  intendedRecipient: string;
}

export interface SitrepMessageDelivery {
  version: 1;
  targets: { recipientKey: string; agentId: string; provider?: string }[];
}

/** Owner-only projection inputs. Never attach this object to agent output cards. */
export interface SitrepOwnerData {
  answers: SitrepOwnerAnswer[];
  states: SamState[];
  claimDecisions: { sourceKey: string; card: LegacyCardRef; value: ClaimDecision }[];
  threads: ThreadMessage[];
  deliveries: PreparedDelivery[];
  groupPriority?: GroupPriority;
  heldNotes?: SitrepHeldNote[];
  commands?: { eventId: string; state: SamState }[];
  threadResponses?: Record<string, string>;
  outboundNotes?: { type: "note" | "hold-notice"; sourceKey: string; eventKey: string; responseId: string; card: LegacyCardRef; at: string; text: string; recipientKeys: string[]; unresolvedRecipients: string[] }[];
  unsupportedResponses?: { responseId: string; reason: string }[];
  responseOrigins?: Record<string, { sourceKey: string; eventKey: string }>;
  threadOrigins?: Record<string, { kind: "legacy"; sourceKey: string } | { kind: "owner-response"; responseId: string } | { kind: "agent-output"; sourceId: string; cardId: string; revision: number; issuanceId: string }>;
}

export interface ProgressTransitionActor {
  operation: "set" | "step" | "note" | "close";
  actorName: string;
  agentId?: string;
  verifiedLive: boolean;
}
