import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CardBody, cardClass, CardTextContext, cardTime, chipClass, focusRing, quietClass } from "./cardKit";
import { createHomeFeedSource } from "./feedStore";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedSource } from "./feedStoreTypes";
import { safeUrl, selectFeed, type FeedCard } from "./feedData";
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

const INTERACTIVE = "a, button, input, textarea, select, label, summary, details, [role='dialog']";

/**
 * The one Home card. Collapsed, it shows the header, the title (whole, or 2
 * lines with `clampTitle`) and the body (3 lines, with "Show more" when it is
 * cut); `children` (answers, actions) always render inside the border.
 * With `onToggle`, tapping the title or any non-interactive part of the card
 * expands it in place.
 */
export function FeedCardView({ card, sample = true, readBody, now, chip, expanded = true, clampTitle = false, onToggle, onEngage, heading = "h2", children }: {
  card: FeedCard;
  sample?: boolean;
  readBody?: (key: string, signal: AbortSignal) => Promise<string>;
  now?: number;
  chip?: ReactNode;
  expanded?: boolean;
  clampTitle?: boolean;
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
  const full = expanded || moreText;
  const when = cardTime(card.at, now ?? Date.now());
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || full) { setCut(false); return; }
    const measure = () => setCut(node.scrollHeight > node.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [full, card.lead.text]);
  return (
    <article className={`${cardClass} ${onToggle ? "cursor-pointer" : ""}`} aria-label={card.title ?? `${card.render} by ${card.author.name}`}
      onFocusCapture={onEngage} onPointerDownCapture={onEngage} onClickCapture={onEngage}
      onClick={onToggle ? (event) => {
        const target = event.target as Element;
        if (target.closest(INTERACTIVE) || window.getSelection()?.toString()) return;
        onToggle();
      } : undefined}>
      <div className="flex min-h-7 min-w-0 items-center gap-2 text-[13px] leading-[18px]">
        {avatar
          ? <img src={avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted object-cover" />
          : <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[12.5px] font-semibold">{card.author.name.trim().charAt(0).toUpperCase() || "?"}</span>}
        <span className="min-w-0 truncate"><span className="font-semibold">{card.author.name}</span>{when && <span className="tabular-nums text-muted-foreground"> · <time dateTime={card.at}>{when}</time></span>}</span>
        {sample && <span className={`ml-auto ${chipClass}`}>{FEED_STRINGS.provenance}</span>}
        {chip && <span className="ml-auto flex shrink-0">{chip}</span>}
      </div>
      {card.title && <Heading className="mt-2.5 break-words text-[17px] font-semibold leading-[1.3] [text-wrap:balance]">
        {onToggle
          ? <button type="button" aria-expanded={expanded} onClick={onToggle} className={`w-full rounded-sm text-left ${clampTitle && !expanded ? "line-clamp-2" : ""} ${focusRing}`}>{card.title}</button>
          : card.title}
      </Heading>}
      {card.lead.text && <div ref={body} className={`mt-1 max-w-[60ch] text-[15px] leading-[1.5] ${full ? "" : "line-clamp-3"}`}><CardBody text={card.lead.text} /></div>}
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

export function FeedViewEntries({ realEntries, source }: { realEntries: unknown; source?: HomeFeedSource }): JSX.Element {
  return source ? <HomeFeedEntries source={source} /> : <SampleFeedEntries realEntries={realEntries} />;
}

export function FeedView({ tcw }: { tcw: TinyCloudWeb | null }): JSX.Element {
  const source = useMemo(() => tcw ? createHomeFeedSource(tcw) : null, [tcw]);
  return source
    ? <FeedViewEntries key={`${tcw?.did}:${tcw?.spaceId}`} realEntries={[]} source={source} />
    : <main aria-label="Feed" className="p-6 text-sm text-muted-foreground">Sign in to load your feed.</main>;
}
