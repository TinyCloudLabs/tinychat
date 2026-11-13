// A post card in the feed: the preview that opens its page (PostPage.tsx, which loads from its own chunk: TC-2882).
import { PlayIcon } from "lucide-react";

import { AgentMark, PlatformName, type Platform } from "./AgentMark";
import { CompactCard, StatusMark } from "./CompactCard";
import type { HomeFeedEntry } from "./feedStoreTypes";
import type { LabPage } from "./postAnswers";
import { ShortTime } from "./ShortTime";

/**
 * A post in the feed. Compact: the feed's compact card with a thumbnail of the page. Full: the header row, title,
 * blurb and the page's image, with how many questions it asks. Either way the whole card opens the page.
 */
export function PostPreview({ entry, page, author, agentKey, platform, status, full, onOpen }: {
  entry: HomeFeedEntry; page: LabPage; author: string; agentKey: string; platform?: Platform; status?: string; full: boolean; onOpen: () => void;
}) {
  const card = entry.state.card;
  const blurb = typeof card.payload?.summary === "string" ? card.payload.summary : card.body;
  const films = page.questions.some((question) => question.media?.some((media) => media.type === "video"));
  if (!full) return <CompactCard agentKey={agentKey} author={author} platform={platform} createdAt={card.createdAt} status={status} title={card.title} description={blurb}
    thumb={{ src: page.image, video: films }} onOpen={onOpen} opensPage />;
  return <button type="button" onClick={onOpen} aria-haspopup="dialog"
    className="block w-full min-w-0 rounded-2xl border border-border bg-card p-4 text-left text-card-foreground shadow-sm active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
    <span className="flex min-w-0 items-start gap-3">
      <AgentMark agentKey={agentKey} name={author} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground"><span className="max-w-[58%] shrink-0 truncate font-semibold text-foreground">{author}</span>{platform && <PlatformName platform={platform} logoOnly />}<ShortTime at={card.createdAt} className="shrink-0 before:mr-1.5 before:content-['·']" />
          <span className="ml-auto flex shrink-0 items-center"><StatusMark status={status} /></span></span>
        <span className="mt-1 block break-words font-display text-xl font-semibold leading-snug">{card.title}</span>
        {blurb && <span className="mt-0.5 block break-words text-sm text-muted-foreground">{blurb}</span>}
      </span>
    </span>
    {/* The one thing a post adds: a look at the page. */}
    <span className="relative mt-3 block overflow-hidden rounded-xl border border-border bg-muted">
      <img src={page.image} alt={page.imageAlt} loading="lazy" className="block aspect-video w-full object-cover" />
      {films && <span aria-hidden className="absolute bottom-2 left-2 flex size-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"><PlayIcon className="size-4" /></span>}
    </span>
    <span className="mt-3 flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">{page.questions.length === 1 ? "1 question" : `${page.questions.length} questions`}</span><span className="font-medium underline decoration-border underline-offset-4">Answer</span></span>
  </button>;
}
