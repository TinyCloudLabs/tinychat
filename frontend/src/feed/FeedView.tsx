import { useEffect, useState, type JSX } from "react";
import { NoteRenderer } from "@/capture/recorder/final/notes/NoteRenderer";
import { parseFeed, safeUrl, type FeedCard } from "./feedData";
import { FEED_STRINGS } from "./strings";

function CardImage({ image }: { image?: FeedCard["image"] }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) return null;
  return <img className="mt-4 max-h-80 w-full rounded-xl border border-border bg-muted object-cover" src={image.src} alt={image.alt} onError={() => setFailed(true)} />;
}

export function FeedCardView({ card }: { card: FeedCard }): JSX.Element {
  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5" aria-label={`${card.render} by ${card.author.name}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
        {card.author.avatar && <img src={card.author.avatar} alt="" className="size-9 shrink-0 rounded-full bg-muted object-cover" />}
        <div className="min-w-[6rem] flex-1">
          <p className="break-words font-semibold">{card.author.name}</p>
          <time dateTime={card.at} className="text-xs text-muted-foreground">{new Date(card.at).toLocaleDateString()}</time>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">{FEED_STRINGS.provenance}</span>
      </div>
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{card.lead}</p>
      {card.render === "post" && <><p className="mt-2 whitespace-pre-wrap break-words text-sm">{card.body}</p><CardImage image={card.image} /></>}
      {card.render === "image" && <CardImage image={card.image} />}
      {card.render === "thread" && card.replies?.map((reply, index) => (
        <div key={`${reply.at}-${index}`} className="mt-3 min-w-0 border-l-2 border-border pl-4 text-sm">
          <p className="font-semibold">{reply.author}</p><p className="whitespace-pre-wrap break-words">{reply.text}</p>
          <time dateTime={reply.at} className="text-xs text-muted-foreground">{new Date(reply.at).toLocaleDateString()}</time>
        </div>
      ))}
      {card.render === "article" && <div className="mt-4 min-w-0 border-t border-border pt-4">
        {card.title && <h2 className="font-display text-xl font-semibold leading-tight break-words">{card.title}</h2>}
        {card.summary && <p className="mt-2 break-words text-sm text-muted-foreground">{card.summary}</p>}
        {card.markdown && <div className="mt-4 min-w-0 overflow-x-auto text-sm"><NoteRenderer md={card.markdown} /></div>}
      </div>}
      {card.render === "link" && <div className="mt-3 min-w-0">
        {card.tldr && <p className="break-words text-sm text-muted-foreground">{card.tldr}</p>}
        {safeUrl(card.url)
          ? <a className="mt-2 inline-flex min-h-8 max-w-full items-center break-all text-sm font-medium underline underline-offset-4" href={card.url} target="_blank" rel="noopener noreferrer">{FEED_STRINGS.openLink}</a>
          : card.url && <span className="mt-2 block break-all text-sm text-muted-foreground">{card.url}</span>}
      </div>}
      {card.source && <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Source: {safeUrl(card.source.url)
        ? <a href={card.source.url} target="_blank" rel="noopener noreferrer" className="inline-block min-h-7 max-w-full break-all underline underline-offset-2">{card.source.label}</a>
        : <span className="break-words">{card.source.label}</span>}</p>}
    </article>
  );
}

export function FeedView(): JSX.Element {
  const [cards, setCards] = useState<FeedCard[] | null>(null);
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
          if (alive && !request.signal.aborted) { setCards([]); setError(false); }
          return;
        }
        if (!response.ok) throw new Error(`Sample feed HTTP ${response.status}`);
        const payload: unknown = await response.json();
        if (alive && !request.signal.aborted) { setCards(parseFeed(payload)); setError(false); }
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

  return <main className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-background text-foreground" aria-label="Feed">
    <div className="mx-auto w-full max-w-2xl min-w-0 px-3 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-6 sm:px-5">
      <header className="mb-6"><h1 className="font-display text-3xl font-semibold tracking-tight">{FEED_STRINGS.heading}</h1><p className="mt-1 text-sm text-muted-foreground">{FEED_STRINGS.subtitle}</p></header>
      {error && <div role="status" className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        <p>{cards?.length ? FEED_STRINGS.stale : FEED_STRINGS.unavailable}</p>
        {!cards?.length && <button type="button" className="mt-2 min-h-8 rounded-md border border-border px-3 font-medium text-foreground" onClick={() => setRetry((value) => value + 1)}>{FEED_STRINGS.retry}</button>}
      </div>}
      {cards === null && !error && <p className="text-sm text-muted-foreground">{FEED_STRINGS.loading}</p>}
      {cards?.length === 0 && <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{FEED_STRINGS.empty}</p>}
      {cards && cards.length > 0 && <div className="grid min-w-0 gap-4">{cards.map((card) => <FeedCardView key={card.id} card={card} />)}</div>}
    </div>
  </main>;
}
