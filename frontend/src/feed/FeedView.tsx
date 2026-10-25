import { useEffect, useState, type JSX } from "react";
import "@/capture/recorder/final/notes/notes.css";
import { safeUrl, selectFeed, type FeedCard } from "./feedData";
import { renderArticleHtml } from "./articleMarkdown";
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

function ArticleMarkdown({ body, renderArticle, readBody }: {
  body: string;
  renderArticle: (markdown: string) => Promise<string>;
  readBody: (key: string, signal: AbortSignal) => Promise<string>;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHtml(null);
    setFailed(false);
    readBody(body, controller.signal).then(renderArticle).then(
      (value) => { if (!controller.signal.aborted) setHtml(value); },
      () => { if (!controller.signal.aborted) setFailed(true); },
    );
    return () => controller.abort();
  }, [body, attempt, renderArticle, readBody]);
  if (failed) return <p className="text-sm text-muted-foreground">
    {FEED_STRINGS.articleUnavailable}{" "}
    <button type="button" className="inline-flex min-h-6 items-center underline underline-offset-2" onClick={() => setAttempt((n) => n + 1)}>{FEED_STRINGS.retry}</button>
  </p>;
  if (html === null) return null;
  return <div className="fmd" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CardImage({ image, alt }: { image?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const src = image ? sampleAssets[image] : undefined;
  if (!src || failed) return null;
  return <img className="mt-4 max-h-80 w-full rounded-xl border border-border bg-muted object-cover" src={src} alt={alt} onError={() => setFailed(true)} />;
}

export function FeedCardView({ card, sample = true, renderArticle = renderArticleHtml, readBody = readArticleBody }: {
  card: FeedCard;
  sample?: boolean;
  renderArticle?: (markdown: string) => Promise<string>;
  readBody?: (key: string, signal: AbortSignal) => Promise<string>;
}): JSX.Element {
  const avatar = card.author.avatar ? sampleAssets[card.author.avatar] : undefined;
  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5" aria-label={`${card.render} by ${card.author.name}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
        {avatar && <img src={avatar} alt="" className="size-9 shrink-0 rounded-full bg-muted object-cover" />}
        <div className="min-w-[6rem] flex-1">
          <p className="break-words font-semibold">{card.author.name}</p>
          <time dateTime={card.at} className="text-xs text-muted-foreground">{new Date(card.at).toLocaleDateString()}</time>
        </div>
        {sample && <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">{FEED_STRINGS.provenance}</span>}
      </div>
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{card.lead.text}</p>
      {(card.render === "post" || card.render === "image") && <CardImage image={card.lead.image} alt={card.lead.text} />}
      {card.render === "thread" && card.replies?.map((reply, index) => (
        <div key={index} className="mt-3 min-w-0 border-l-2 border-border pl-4 text-sm">
          <p className="whitespace-pre-wrap break-words">{reply.text}</p>
        </div>
      ))}
      {card.render === "article" && <div className="mt-4 min-w-0 border-t border-border pt-4">
        {card.title && <h2 className="font-display text-xl font-semibold leading-tight break-words">{card.title}</h2>}
        {card.body && <div className="mt-4 min-w-0 overflow-x-auto text-sm"><ArticleMarkdown body={card.body} renderArticle={renderArticle} readBody={readBody} /></div>}
      </div>}
      {card.render === "link" && card.url && <div className="mt-3 min-w-0">
        {safeUrl(card.url)
          ? <a className="mt-2 inline-flex min-h-8 max-w-full items-center break-all text-sm font-medium underline underline-offset-4" href={card.url} target="_blank" rel="noopener noreferrer">{FEED_STRINGS.openLink}</a>
          : <span className="mt-2 block break-all text-sm text-muted-foreground">{card.url}</span>}
      </div>}
      {card.source && <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Source: {card.source.url
        ? <a href={card.source.url} target="_blank" rel="noopener noreferrer" className="inline-block min-h-7 max-w-full break-all underline underline-offset-2">{card.source.label}</a>
        : <span className="break-words">{card.source.label}{card.source.ref && ` · ${card.source.ref}`}</span>}</p>}
    </article>
  );
}

export function FeedViewEntries({ realEntries }: { realEntries: unknown }): JSX.Element {
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

export function FeedView(): JSX.Element {
  return <FeedViewEntries realEntries={[]} />;
}
