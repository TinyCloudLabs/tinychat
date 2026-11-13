import type {
  FeedCard,
  FeedCardState,
  FeedOwnerSettings,
  FeedOwnerView,
  FeedResponse,
  FeedSelector,
  FeedResponsePayload,
  FeedResponseHandling,
  NewFeedMessage,
  FeedSource,
  NewFeedResponse,
} from "@tinycloud/sdk-services/feed";
import type { PreparedRecipient, SamState, SitrepMessageDelivery, SitrepOwnerData, SitrepHeldNote } from "@tinyboilerplate/core/feed/sitrep";

export interface HomeFeedViewEvent {
  sequence: number;
  kind: "seen" | "snoozed";
  createdAt: string;
  snoozedUntil?: string;
}

export interface HomeFeedOwnerEvent {
  eventId: string;
  state: SamState;
}

export type HomeFeedMessageDraft = NewFeedMessage;

export type HomeThreadRoute =
  | { kind: "publisher" }
  | { kind: "recipients"; delivery: SitrepMessageDelivery }
  | { kind: "held"; unresolved: string[] };
export interface HomeHistoricalCommand {
  responseId: string;
  sourceKey: string;
  eventKey: string;
  state: SamState;
}

export interface HomeFeedEntry {
  source: FeedSource;
  state: FeedCardState;
  view: FeedOwnerView;
  responses?: FeedResponse[];
  viewEvents?: HomeFeedViewEvent[];
  owner?: SitrepOwnerData;
  responseHandling?: Record<string, FeedResponseHandling>;
  recipientRoute?: { recipients: PreparedRecipient[]; unresolved: string[]; receiptRecipients?: PreparedRecipient[] };
  /** Only validated owner archives may join relationships across registered sources. */
  modelScope?: string;
  currentIssuance?: boolean;
  historicalCommands?: HomeHistoricalCommand[];
  threadRoutes?: Record<string, HomeThreadRoute>;
  /**
   * A plain card's earlier revisions in the agent's output, oldest first (listFeedCardHistory).
   * An agent's replies arrive as new revisions, so these time each reply and link a reply-only
   * revision to the one it follows, including revisions that never loaded as entries.
   */
  earlierRevisions?: FeedCard[];
}

export interface HomeFeedSnapshot {
  entries: HomeFeedEntry[];
  settings: FeedOwnerSettings;
  focusedEntry?: HomeFeedEntry;
  historicalEntries?: HomeFeedEntry[];
  relatedEntries?: HomeFeedEntry[];
  connectionError?: string;
  sitrep?: SitrepOwnerData;
}

/** What happened to an answer held in the page-close outbox when Home came back. */
export interface HeldAnswerOutcome {
  sourceId: string;
  cardId: string;
  /**
   * "sent": sent now, with its original responseId. Not sent: "replaced", a newer revision changed
   * the request; "closed", the agent closed, ended or expired it; "refused", the feed rejected it.
   * (An answer the owner already replaced with a newer one is cleared without an outcome.)
   */
  outcome: "sent" | "replaced" | "closed" | "refused";
  /** The chosen option's label on the answered revision; absent for an answer in words. */
  choiceLabel?: string;
  /** "replaced": the answered revision, which stays on screen with the refusal until the owner moves on. */
  answered?: HomeFeedEntry;
}

export interface HomeFeedSaveOptions {
  /**
   * Hold the answer in the page-close outbox first, synchronously, until the write is confirmed
   * or refused: a page that closes before it lands sends it at the next launch.
   */
  hold?: boolean;
}

/** Owner-session persistence boundary; notifications invalidate durable reads. */
export interface HomeFeedLoadOptions {
  /** The Feed shows this snapshot and reloads on `subscribe`: live-update catch-up compares against it. */
  feed?: boolean;
}

export interface HomeFeedSource {
  load(focused?: HomeFeedEntry, options?: HomeFeedLoadOptions): Promise<HomeFeedSnapshot>;
  /** Load the server snapshot before the initial local cache read, so a prior miss cannot mask a new answer. */
  cached?: () => Promise<HomeFeedSnapshot | null>;
  saveResponse(entry: HomeFeedEntry, response: NewFeedResponse, payload?: FeedResponsePayload, options?: HomeFeedSaveOptions): Promise<FeedResponse>;
  holdsAnswer?(entry: HomeFeedEntry, responseId: string): boolean;
  flushHeldAnswers?(): Promise<HeldAnswerOutcome[]>;
  sendMessage?: (entry: HomeFeedEntry, message: HomeFeedMessageDraft, payload?: FeedResponsePayload) => Promise<FeedResponse>;
  saveOwnerState?: (entry: HomeFeedEntry, event: HomeFeedOwnerEvent) => Promise<void>;
  saveHeldNote?: (entry: HomeFeedEntry, note: SitrepHeldNote) => Promise<void>;
  setGroupPriority?: (entry: HomeFeedEntry, group: string, on: boolean) => Promise<void>;
  markSeen(entry: HomeFeedEntry): Promise<void>;
  snooze(entry: HomeFeedEntry, until: string): Promise<void>;
  setDefaultSelector(selector: FeedSelector): Promise<void>;
  subscribe(onChange: () => void): () => void;
  readBody?: (key: string, signal: AbortSignal) => Promise<string>;
}

export interface HomeFeedEntriesProps {
  realEntries: unknown;
  source: HomeFeedSource;
}
