import type {
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

/** Owner-session persistence boundary; notifications invalidate durable reads. */
export interface HomeFeedSource {
  load(focused?: HomeFeedEntry): Promise<HomeFeedSnapshot>;
  /** The device's last loaded feed for this account, shown while `load` refreshes it; null when none. */
  cached?: () => Promise<HomeFeedSnapshot | null>;
  saveResponse(entry: HomeFeedEntry, response: NewFeedResponse, payload?: FeedResponsePayload): Promise<FeedResponse>;
  sendMessage?: (entry: HomeFeedEntry, message: HomeFeedMessageDraft, payload?: FeedResponsePayload) => Promise<FeedResponse>;
  saveOwnerState?: (entry: HomeFeedEntry, event: HomeFeedOwnerEvent) => Promise<void>;
  saveHeldNote?: (entry: HomeFeedEntry, note: SitrepHeldNote) => Promise<void>;
  setGroupPriority?: (entry: HomeFeedEntry, group: string, on: boolean) => Promise<void>;
  markSeen(entry: HomeFeedEntry): Promise<void>;
  snooze(entry: HomeFeedEntry, until: string): Promise<void>;
  setDefaultSelector(selector: FeedSelector): Promise<void>;
  subscribe(onChange: () => void): () => void;
  readBody?: (key: string, signal: AbortSignal) => Promise<string>;
  /** Feed lab only: adds more made-up cards at the end of the feed, for its infinite scroll. */
  loadMore?: () => Promise<void>;
  /**
   * Feed lab only: up to `limit` cards you already answered, each answered before `before` (or now), newest answer
   * first. Pulling down at the top of the feed shows them, back indefinitely.
   */
  loadAnswered?: (before: string | undefined, limit: number) => Promise<HomeFeedEntry[]>;
}

export interface HomeFeedEntriesProps {
  realEntries: unknown;
  source: HomeFeedSource;
}
