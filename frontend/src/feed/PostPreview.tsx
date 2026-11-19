// A post card in the feed: the row that opens its page (PostPage.tsx, which loads from its own chunk: TC-2882).
import type { Platform } from "./AgentMark";
import { CompactCard } from "./CompactCard";
import type { HomeFeedEntry } from "./feedStoreTypes";
import type { LabPage } from "./postAnswers";

/** A post in the feed: the feed's row with a thumbnail of the page. The whole row opens the page. */
export function PostPreview({ entry, page, author, agentKey, platform, status, onOpen }: {
  entry: HomeFeedEntry; page: LabPage; author: string; agentKey: string; platform?: Platform; status?: string; onOpen: () => void;
}) {
  const card = entry.state.card;
  const blurb = typeof card.payload?.summary === "string" ? card.payload.summary : card.body;
  const films = page.questions.some((question) => question.media?.some((media) => media.type === "video"));
  return <CompactCard agentKey={agentKey} author={author} platform={platform} createdAt={card.createdAt} status={status} title={card.title} description={blurb}
    thumb={{ src: page.image, video: films }} onOpen={onOpen} opensPage />;
}
