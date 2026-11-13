// Sam, 23:5xZ: "there can be a undo at the bottom like in sitrep for some of the actions that are not ui
// easy to do (like drop should remove the card)". An action that takes a card away (Drop this card, Acknowledge,
// Ask me later, Show me later) takes it away at once; a bar at the bottom of the screen says what happened, counts
// the same 5 seconds as every send and offers Undo, which puts the card back where it was. Nothing reaches the agent
// until the count ends. Several actions in a row stack, newest at the bottom; a page that closes or hides sends them
// at once, as an answer's count does. A commit is the caller's held send (sendOwnerAction with { hold: true }): it
// lands in the page-close outbox before its first await, so a page that closes mid-write still sends it next launch.
import { useCallback, useEffect, useRef, useState } from "react";
import { UNDO_SECONDS } from "./cardKit";

export interface UndoItem {
  /** The card it takes away, hidden from the list while the bar counts. */
  key: string;
  /** What happened: "Dropped", "Acknowledged", "Back at 08:00". */
  text: string;
  /** What the count ends with: the write the agent hears about. */
  commit: () => Promise<unknown>;
  /** Anything to put back on Undo beyond showing the card again. */
  undo?: () => void;
}
interface Pending extends UndoItem { id: number; endsAt: number }

/** At most this many bars show; an older one beyond them is committed at once. */
const MAX_BARS = 3;

export function useUndoBar(onError: (message: string, cause?: unknown) => void) {
  const [items, setItems] = useState<Pending[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const live = useRef<Pending[]>([]);
  const nextId = useRef(1);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const commit = useCallback((item: Pending) => {
    live.current = live.current.filter((other) => other.id !== item.id);
    setItems(live.current);
    // A plain sentence, never the store's own error text; the cause goes along so the caller can tell a held send.
    item.commit().catch((cause: unknown) => errorRef.current("That didn't reach the agent.", cause));
  }, []);
  // One tick a second while anything counts; each bar ends on its own time.
  useEffect(() => {
    if (!items.length) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      for (const item of live.current.filter((pending) => pending.endsAt <= at)) commit(item);
    }, 250);
    return () => clearInterval(timer);
  }, [items.length, commit]);
  // A closed or hidden page may never finish the count, so whatever waits is sent now; so on leaving the feed.
  useEffect(() => {
    const flush = () => { for (const item of [...live.current]) commit(item); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); flush(); };
  }, [commit]);
  const push = useCallback((item: UndoItem) => {
    const pending: Pending = { ...item, id: nextId.current++, endsAt: Date.now() + UNDO_SECONDS * 1000 };
    const kept = live.current.filter((other) => other.key !== item.key);
    live.current = [...kept, pending];
    for (const old of live.current.slice(0, Math.max(0, live.current.length - MAX_BARS))) commit(old);
    setNow(Date.now());
    setItems(live.current);
  }, [commit]);
  const undo = useCallback((id: number) => {
    const item = live.current.find((pending) => pending.id === id);
    live.current = live.current.filter((pending) => pending.id !== id);
    setItems(live.current);
    item?.undo?.();
  }, []);
  const hidden = useCallback((key: string) => items.some((item) => item.key === key), [items]);
  // The stack's height (0 when no bar shows), so the feed can add it to its bottom padding and its last cards scroll
  // clear of the bars (QA cb784d4, P3).
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const stackRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) { setHeight(0); return; }
    setHeight(node.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.current.observe(node);
  }, []);
  // Clear of a phone's home indicator in the native shell (safe-area inset), 1.5rem above the edge elsewhere.
  const bar = !!items.length && <div ref={stackRef} className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.5rem))] z-30 flex flex-col items-center gap-2 px-3">
    {/* One width for every bar, so a stack lines up (the design agent). */}
    {items.map((item) => <p key={item.id} role="status" className="pointer-events-auto flex min-h-11 min-w-[15rem] items-center justify-between gap-3 rounded-full bg-zinc-900 py-1 pl-4 pr-1 text-sm text-zinc-100 shadow-lg dark:bg-zinc-100 dark:text-zinc-900 fine:min-h-10">
      <span className="tabular-nums">{item.text} · {Math.max(1, Math.ceil((item.endsAt - now) / 1000))}s</span>
      <button type="button" onClick={() => undo(item.id)} className="min-h-9 rounded-full bg-zinc-100 px-3 font-semibold text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">Undo</button>
    </p>)}
  </div>;
  return { push, hidden, bar, height };
}
