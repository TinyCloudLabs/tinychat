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
}

export interface HomeFeedEntriesProps {
  realEntries: unknown;
  source: HomeFeedSource;
}
