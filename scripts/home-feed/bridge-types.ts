import type { IKVService, ISQLService } from "@tinycloud/sdk-services";
import type { FeedCard, FeedCardIdentity, FeedSource } from "@tinycloud/sdk-services/feed";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";

/** Already-authorized owner handles; these arguments never grant authority. */
export interface HomeMirrorContext {
  ownerSpaceId: string;
  sql: Pick<ISQLService, "db">;
  legacySpaceId: string;
  legacy: Pick<IKVService, "get" | "put">;
  now: () => string;
  signal?: AbortSignal;
}

export interface HomeMirrorPublishInput {
  source: FeedSource;
  card: FeedCard;
  legacy: {
    spaceId: string;
    fullKey: string;
    /** Business identity remains unchanged, including claim IDs such as L-042. */
    record: BoardRecord;
  };
}

/** Owner-only publication binding, persisted in home_feed.feed_sitrep_mirrors. */
export interface HomeMirrorBinding {
  version: 1;
  source: Pick<FeedSource, "sourceId" | "agentDid" | "output" | "responses">;
  identity: FeedCardIdentity;
  cardUuid: string;
  legacy: {
    spaceId: string;
    fullKey: string;
    kind: Kind;
    id: string;
    publicationSha256: string;
    publishedETag: string;
  };
}

export interface HomeMirrorIdentity extends FeedCardIdentity {
  sourceId: string;
}

/** Projection evidence only: never agent acknowledgement, outcome or permission. */
export interface HomeMirrorCloseReceipt {
  version: 1;
  sourceId: string;
  identity: FeedCardIdentity;
  responseId: string;
  legacyKey: string;
  publicationSha256: string;
  expectedETag: string;
  closedETag: string;
  status: string;
  observedAt: string;
}
