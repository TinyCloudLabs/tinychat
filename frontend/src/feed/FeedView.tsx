import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { HomeAskBox } from "@/bots/HomeAskBox";
import { AgentDetails, AgentMark, PlatformName, type AgentProfile } from "./AgentMark";
import { StatusMark } from "./CompactCard";
import { homeFeedSourceFor } from "./feedStore";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedSource } from "./feedStoreTypes";
import { safeUrl, selectFeed, type FeedCard } from "./feedData";
import { ShortTime } from "./ShortTime";
import { FEED_SKILL_URL, FEED_STRINGS } from "./strings";

// These keys belong to the bundled sample only. A real card's media key is never a web URL.
const sampleAssets: Record<string, string> = {
  "birch/assets/shapes.svg": "/home-feed-shapes.svg",
  "dune/articles/second-glance.md": "/home-feed-article.md",
};

async function readArticleBody(key: string, signal: AbortSignal): Promise<string> {
  const path = sampleAssets[key];
  if (!path || !key.endsWith(".md")) throw new Error("Article body unavailable");
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Article body unavailable");
  return response.text();
}

function ArticleBody({ body, readBody }: {
  body: string;
  readBody: (key: string, signal: AbortSignal) => Promise<string>;
}) {
  const [paragraphs, setParagraphs] = useState<string[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setParagraphs(null);
    readBody(body, controller.signal).then(
      (text) => {
        if (!controller.signal.aborted && text.length <= 20_000) {
          setParagraphs(text.split(/\r?\n[ \t]*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean));
        }
      },
      () => { /* Unreadable body: the title and lead remain. */ },
    );
    return () => controller.abort();
  }, [body, readBody]);
  if (!paragraphs?.length) return null;
  return <div className="article-body mt-4 min-w-0 break-words text-sm">
    {paragraphs.map((paragraph, index) => <p key={index} className="mt-3 whitespace-pre-wrap leading-relaxed">{paragraph}</p>)}
  </div>;
}

function CardImage({ image, alt }: { image?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const src = image ? sampleAssets[image] : undefined;
  if (!src || failed) return null;
  return <img className="mt-4 max-h-80 w-full rounded-xl border border-border bg-muted object-cover" src={src} alt={alt} onError={() => setFailed(true)} />;
}

export function FeedCardView({ card, sample = true, readBody, status, onAuthor, agent, collapse, plain = false, children }: {
  card: FeedCard;
  sample?: boolean;
  readBody?: (key: string, signal: AbortSignal) => Promise<string>;
  /** The card's one status word ("Needs you", "Done"). */
  status?: string;
  /** Opens everything between the person and the card's agent. */
  onAuthor?: () => void;
  /** The acting agent: its mark and, when it reported one, its platform. Tapping its name shows what it is. */
  agent?: { key: string; profile?: AgentProfile };
  /** A card opened in place from a list: its "Show less" control, at the top right beside the status. */
  collapse?: ReactNode;
  /** On a page of its own (a post's page): no card surface around it, so it isn't a card within a card. */
  plain?: boolean;
  /** The rest of an open card (its options, reply and actions), inside the same surface. */
  children?: ReactNode;
}): JSX.Element {
  const [about, setAbout] = useState(false);
  const avatar = sample && card.author.avatar ? sampleAssets[card.author.avatar] : undefined;
  const platform = agent?.profile?.platform;
  return (
    <article className={plain ? "min-w-0 text-foreground" : `min-w-0 overflow-hidden rounded-2xl border bg-card p-4 text-card-foreground sm:p-5 ${agent ? "border-foreground/20 shadow-float" : "border-border shadow-sm"}`} aria-label={`${card.render} by ${card.author.name}`}>
      <div className="flex min-w-0 items-start gap-3 text-sm">
        {agent ? <AgentMark agentKey={agent.key} name={card.author.name} /> : avatar && <img src={avatar} alt="" className="size-9 shrink-0 rounded-full bg-muted object-cover" />}
        <div className="min-w-[6rem] flex-1">
          <p data-agent-line className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* The name is 24px tall; its ::after stretches the tap target to 44px without moving the line (critique #8). */}
            {onAuthor ? <button type="button" aria-expanded={agent ? about : undefined} onClick={agent ? () => setAbout(!about) : onAuthor} className="relative min-h-6 break-words text-left font-semibold underline decoration-border underline-offset-4 after:absolute after:-inset-x-1 after:-inset-y-2.5 fine:after:hidden">{card.author.name}</button> : <span className="break-words font-semibold">{card.author.name}</span>}
            {platform && <PlatformName platform={platform} chip />}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{card.author.via && <>via {card.author.via} · </>}<ShortTime at={card.at} /></p>
        </div>
        {sample && <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">{FEED_STRINGS.provenance}</span>}
        {/* The same status mark as the compact card, so a card keeps its status look when it opens. */}
        {status && status !== "Information" && <span data-status className="flex min-h-6 shrink-0 items-center"><StatusMark status={status} /></span>}
        {collapse && <span className="-my-1.5 -mr-1.5 shrink-0">{collapse}</span>}
      </div>
      {agent && about && <div className="mt-3"><AgentDetails name={card.author.name} via={card.author.via} profile={agent.profile} onOpen={onAuthor} /></div>}
      {card.title && card.render !== "article" && <h2 className="mt-4 break-words font-display text-title-2">{card.title}</h2>}
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{card.lead.text}</p>
      {sample && (card.render === "post" || card.render === "image") && <CardImage image={card.lead.image} alt={card.lead.text} />}
      {card.render === "thread" && card.replies?.map((reply, index) => (
        <div key={index} className="mt-3 min-w-0 border-l-2 border-border pl-4 text-sm">
          <p className="whitespace-pre-wrap break-words">{reply.text}</p>
        </div>
      ))}
      {card.render === "article" && <div className="mt-4 min-w-0 border-t border-border pt-4">
        {card.title && <h2 className="break-words font-display text-title-2">{card.title}</h2>}
        {card.body && (sample || readBody) && <ArticleBody body={card.body} readBody={readBody ?? readArticleBody} />}
      </div>}
      {card.render === "link" && card.url && <div className="mt-3 min-w-0">
        {safeUrl(card.url)
          ? <a className="mt-2 inline-flex min-h-8 max-w-full items-center break-all text-sm font-medium underline underline-offset-4" href={card.url} target="_blank" rel="noopener noreferrer">{FEED_STRINGS.openLink}</a>
          : <span className="mt-2 block break-all text-sm text-muted-foreground">{card.url}</span>}
      </div>}
      {card.source && <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Source: {card.source.url
        ? <a href={card.source.url} target="_blank" rel="noopener noreferrer" className="inline-block min-h-7 max-w-full break-all underline underline-offset-2">{card.source.label}</a>
        : <span className="break-words">{card.source.label}{card.source.ref && ` · ${card.source.ref}`}</span>}</p>}
      {children}
    </article>
  );
}

function SampleFeedEntries({ realEntries }: { realEntries: unknown }): JSX.Element {
  const [sampleEntries, setSampleEntries] = useState<unknown | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: NodeJS.Timeout | number | undefined;
    let alive = true;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const response = await fetch("/home-feed-sample.json", { cache: "no-store", signal: request.signal });
        if (response.status === 404) {
          if (alive && !request.signal.aborted) { setSampleEntries([]); setError(false); }
          return;
        }
        if (!response.ok) throw new Error(`Sample feed HTTP ${response.status}`);
        const payload: unknown = await response.json();
        if (alive && !request.signal.aborted) { setSampleEntries(payload); setError(false); }
      } catch {
        if (alive && !request.signal.aborted) setError(true);
      } finally {
        if (controller === request) controller = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        timer ??= setInterval(() => void refresh(), 30_000);
      } else {
        clearInterval(timer);
        timer = undefined;
        controller?.abort();
        controller = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      controller?.abort();
    };
  }, [retry]);

  const { cards, sample } = selectFeed(realEntries, sampleEntries);
  return <main className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-background text-foreground" aria-label="Feed">
    <div className="mx-auto w-full max-w-2xl min-w-0 px-3 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-6 sm:px-5">
      <header className="mb-6"><h1 className="font-display text-3xl font-semibold tracking-tight">{FEED_STRINGS.heading}</h1><p className="mt-1 text-sm text-muted-foreground">{FEED_STRINGS.subtitle}</p></header>
      {sample && <section className="mb-5 rounded-xl border border-border bg-card p-4 text-sm" aria-label={FEED_STRINGS.getStartedHeading}>
        <h2 className="font-display text-lg font-semibold">{FEED_STRINGS.getStartedHeading}</h2>
        <p className="mt-2">{FEED_STRINGS.getStartedBody}</p>
        <a href={FEED_SKILL_URL} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-8 items-center underline underline-offset-2">{FEED_STRINGS.howAgentsPost}</a>
      </section>}
      {error && <div role="status" className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        <p>{cards.length ? FEED_STRINGS.stale : FEED_STRINGS.unavailable}</p>
        {!cards.length && <button type="button" className="mt-2 min-h-8 rounded-md border border-border px-3 font-medium text-foreground" onClick={() => setRetry((value) => value + 1)}>{FEED_STRINGS.retry}</button>}
      </div>}
      {sampleEntries === null && !error && !cards.length && <p className="text-sm text-muted-foreground">{FEED_STRINGS.loading}</p>}
      {sampleEntries !== null && !cards.length && <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{FEED_STRINGS.empty}</p>}
      {cards.length > 0 && <div className="grid min-w-0 gap-4">{cards.map((card) => <FeedCardView key={card.key} card={card} sample={sample} />)}</div>}
    </div>
  </main>;
}

export function FeedViewEntries({ realEntries, source, ask }: { realEntries: unknown; source?: HomeFeedSource; ask?: ReactNode }): JSX.Element {
  return source ? <HomeFeedEntries source={source} ask={ask} /> : <SampleFeedEntries realEntries={realEntries} />;
}

export function FeedView({ tcw, onReconnect }: { tcw: TinyCloudWeb | null; onReconnect?: () => void }): JSX.Element {
  const source = useMemo(() => tcw ? homeFeedSourceFor(tcw) : null, [tcw]);
  return source
    ? <FeedViewEntries key={`${tcw?.did}:${tcw?.spaceId}`} realEntries={[]} source={source} ask={<HomeAskBox tcw={tcw ?? undefined} onReconnect={onReconnect} />} />
    : <main aria-label="Feed" className="p-6 text-sm text-muted-foreground">Sign in to load your feed.</main>;
}
