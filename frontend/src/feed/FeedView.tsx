import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { HomeAskBox } from "@/bots/HomeAskBox";
import { CardBody, cardClass, CardTextContext, cardTime, chipClass, COMMENT_COPY, focusRing, quietClass } from "./cardKit";
import { MessageCircleIcon } from "lucide-react";
import { homeFeedSourceFor } from "./feedStore";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedSource } from "./feedStoreTypes";
import { safeUrl, selectFeed, type FeedCard } from "./feedData";
import { FEED_SKILL_URL, FEED_STRINGS } from "./strings";
import { AgentDetails, AgentMark, PlatformName, type AgentProfile } from "./AgentMark";
import { StatusMark } from "./CompactCard";
import { ShortTime } from "./ShortTime";

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

const INTERACTIVE = "a, button, input, textarea, select, label, summary, details, [role='dialog']";

/**
 * The one Home card. Collapsed, it shows the header, the title (whole, or 2
 * lines with `clampTitle`) and the body (3 lines, with "Show more" when it is
 * cut); `children` (answers, actions) always render inside the border.
 * With `onToggle`, tapping the title or any non-interactive part of the card
 * expands it in place.
 */
export function FeedCardView({ card, sample = true, readBody, now, chip, comments = 0, onOpenComments, expanded = true, clampTitle = false, compact = false, onToggle, onEngage, heading = "h2", children }: {
  card: FeedCard;
  sample?: boolean;
  readBody?: (key: string, signal: AbortSignal) => Promise<string>;
  now?: number;
  chip?: ReactNode;
  expanded?: boolean;
  clampTitle?: boolean;
  /** The card's comment count, shown on the collapsed card when there are any. */
  comments?: number;
  /** Opens the card at its comments. */
  onOpenComments?: () => void;
  /** Header and title only (no body): a snoozed or unreadable card. */
  compact?: boolean;
  onToggle?: () => void;
  onEngage?: () => void;
  heading?: "h2" | "h3";
  children?: ReactNode;
}): JSX.Element {
  const avatar = sample && card.author.avatar ? sampleAssets[card.author.avatar] : undefined;
  const Heading = heading;
  const [moreText, setMoreText] = useState(false);
  const [cut, setCut] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const toComments = useRef(false);
  useEffect(() => {
    if (!expanded || !toComments.current) return;
    toComments.current = false;
    article.current?.querySelector(`[aria-label="${COMMENT_COPY.list}"]`)?.scrollIntoView({ block: "nearest" });
  }, [expanded]);
  const full = expanded || moreText;
  const when = cardTime(card.at, now ?? Date.now());
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || full) { setCut(false); return; }
    const measure = () => setCut(node.scrollHeight > node.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [full, compact, card.lead.text]);
  return (
    <article ref={article} className={`${cardClass} ${onToggle ? "cursor-pointer" : ""}`} aria-label={card.title ?? `${card.render} by ${card.author.name}`}
      onFocusCapture={onEngage} onPointerDownCapture={onEngage} onClickCapture={onEngage}
      onClick={onToggle ? (event) => {
        const target = event.target as Element;
        if (target.closest(INTERACTIVE) || window.getSelection()?.toString()) return;
        onToggle();
      } : undefined}>
      {/* The agent name stays whole; a chip that doesn't fit wraps to its own line. */}
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[18px]">
        {avatar
          ? <img src={avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted object-cover" />
          : <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[12.5px] font-semibold">{card.author.name.trim().charAt(0).toUpperCase() || "?"}</span>}
        <span className="min-w-0 break-words"><span className="font-semibold">{card.author.name}</span>{when && <span className="whitespace-nowrap tabular-nums text-muted-foreground"> · <time dateTime={card.at}>{when}</time></span>}</span>
        {sample && <span className={`ml-auto ${chipClass}`}>{FEED_STRINGS.provenance}</span>}
        {(chip || (!expanded && comments > 0 && onOpenComments)) && <span className="ml-auto flex shrink-0 items-center gap-2">
          {!expanded && comments > 0 && onOpenComments && <button type="button" aria-label={COMMENT_COPY.count(comments)} onClick={() => { toComments.current = true; onOpenComments(); }}
            className={`-my-2 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md text-[13px] tabular-nums text-muted-foreground hover:text-foreground ${focusRing}`}>
            <MessageCircleIcon aria-hidden className="size-4" />{comments}
          </button>}
          {chip}
        </span>}
      </div>
      {card.title && <Heading className="mt-2.5 break-words text-[17px] font-semibold leading-[1.3] [text-wrap:balance]">
        {onToggle
          ? <button type="button" aria-expanded={expanded} onClick={onToggle} className={`w-full rounded-sm text-left ${clampTitle && !expanded ? "line-clamp-2" : ""} ${focusRing}`}>{card.title}</button>
          : card.title}
      </Heading>}
      {!compact && card.lead.text && <div ref={body} className={`mt-1 max-w-[60ch] text-[15px] leading-[1.5] ${full ? "" : "line-clamp-3"}`}><CardBody text={card.lead.text} /></div>}
      {/* The 44px target overlaps the next block, so the visible gap to the options stays 12px. */}
      {cut && !full && <button type="button" className={`${quietClass} -mb-4`} onClick={() => setMoreText(true)}>Show more</button>}
      {sample && (card.render === "post" || card.render === "image") && <CardImage image={card.lead.image} alt={card.lead.text} />}
      {expanded && card.render === "thread" && card.replies?.map((reply, index) => (
        <div key={index} className="mt-3 min-w-0 border-l border-border pl-4 text-[15px]">
          <p className="whitespace-pre-wrap break-words">{reply.text}</p>
        </div>
      ))}
      {expanded && card.render === "article" && card.body && (sample || readBody) && <ArticleBody body={card.body} readBody={readBody ?? readArticleBody} />}
      {card.render === "link" && card.url && <div className="mt-1 min-w-0">
        {safeUrl(card.url)
          ? <a className="inline-flex min-h-11 max-w-full items-center break-all text-sm underline underline-offset-[3px]" href={card.url} target="_blank" rel="noopener noreferrer">{FEED_STRINGS.openLink}</a>
          : <span className="mt-2 block break-all text-sm text-muted-foreground">{card.url}</span>}
      </div>}
      <CardTextContext.Provider value={full}>{children}</CardTextContext.Provider>
      {expanded && card.source && <p className="mt-3 text-[13px] text-muted-foreground">Source: {card.source.url
        ? <a href={card.source.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 max-w-full items-center break-all underline underline-offset-[3px]">{card.source.label}</a>
        : <span className="break-words">{card.source.label}{card.source.ref && ` · ${card.source.ref}`}</span>}</p>}
    </article>
  );
}

/**
 * The Home feed's card, open (the feed lab's design, approved 11-13): one meta line like the compact card's (the
 * agent's mark, its name, its platform's mark, the time, and at the right the status and "Show less"), the title, the
 * body, then `children` (options, conversation, the foot) inside the same surface. `FeedCardView` above stays for the
 * sample feed and the demo card.
 */
export function HomeCardView({ card, sample = true, readBody, status, onAuthor, agent, collapse, plain = false, children }: {
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
  // Long unbroken tokens (commit hashes, file paths, URLs) wrap instead of running past the card's edge: overflow-wrap is
  // inherited, and `anywhere` breaks a token only where it cannot fit on a line of its own.
  return (
    <article className={plain ? "min-w-0 text-foreground [overflow-wrap:anywhere]" : `min-w-0 overflow-hidden rounded-2xl border bg-card p-4 text-card-foreground [overflow-wrap:anywhere] sm:p-5 ${agent ? "border-foreground/20 shadow-float" : "border-border shadow-sm"}`} aria-label={`${card.render} by ${card.author.name}`}>
      {/* One meta line, the compact card's (design round 7), so a card keeps its header row when it opens: the agent's
          mark, its name, its platform's mark, the time, and at the right the status and "Show less". */}
      <div className="flex min-w-0 items-center gap-3">
        {agent ? <AgentMark agentKey={agent.key} name={card.author.name} small /> : avatar && <img src={avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted object-cover" />}
        <div className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 text-meta text-muted-foreground">
          <span data-agent-line className="flex min-w-0 max-w-[60%] shrink-0 items-center gap-1.5">
            {/* The name's own box is 44px tall on touch, pulled back by its negative margin so the line stays 24px (critique #8, QA cb784d4). */}
            {onAuthor
              ? <button type="button" aria-expanded={agent ? about : undefined} onClick={agent ? () => setAbout(!about) : onAuthor} className="-my-2.5 flex min-h-11 min-w-11 max-w-full shrink-0 items-center text-left font-semibold text-foreground fine:my-0 fine:min-h-6 fine:min-w-0"><span className="truncate underline decoration-border underline-offset-2">{card.author.name}</span></button>
              : <span className="max-w-full shrink-0 truncate font-semibold text-foreground">{card.author.name}</span>}
            {platform && <span className="flex min-w-0 shrink items-center"><PlatformName platform={platform} logoOnly /></span>}
          </span>
          <p className={`flex items-center gap-1.5 before:content-['·'] ${card.author.via ? "min-w-0" : "shrink-0"}`}>{card.author.via && <span className="min-w-0 truncate">{`via ${card.author.via} · `}</span>}<ShortTime at={card.at} day className="shrink-0 tabular-nums" /></p>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {sample && <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{FEED_STRINGS.provenance}</span>}
            {/* The same status mark as the compact card, so a card keeps its status look when it opens. */}
            {status && status !== "Information" && <span data-status className="flex shrink-0 items-center"><StatusMark status={status} /></span>}
            {collapse && <span className="-my-1.5 -mr-1.5 shrink-0">{collapse}</span>}
          </span>
        </div>
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
