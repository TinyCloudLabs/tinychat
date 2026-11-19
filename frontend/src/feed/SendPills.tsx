import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";

import { UNDO_SECONDS } from "./cardKit";

/** One line of the pill stack: a wait with Undo and its count, a write in flight, or a send that landed. */
export interface PillItem {
  id: string;
  text: string;
  /** Present while the count runs; the pill then has Undo. */
  seconds?: number;
  onUndo?: () => void;
  /** What a screen reader hears when the pill appears. */
  status: string;
  /** An answer's pill takes focus when it appears, since its card is gone. */
  focus?: boolean;
  /** A send that landed: marked with a tick. */
  done?: boolean;
}

const RING = 2 * Math.PI * 10;

function Pill({ item, onUndo }: { item: PillItem; onUndo: (item: PillItem) => void }) {
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (item.focus) undo.current?.focus(); }, [item.focus]);
  const counting = item.seconds !== undefined && item.onUndo;
  // Escape undoes the wait that has focus, as it did inside the card.
  return <div onKeyDown={counting ? (event) => { if (event.key === "Escape") { event.preventDefault(); onUndo(item); } } : undefined}
    className="pointer-events-auto flex h-11 min-w-[15rem] max-w-[calc(100%-1.5rem)] items-center justify-between gap-2 rounded-full bg-foreground py-1 pl-4 pr-2 text-[13.5px] font-semibold text-background shadow-[0_10px_24px_-8px_rgb(0_0_0/0.5)]">
    <span className="flex min-w-0 items-center gap-1.5 break-words">{item.done && <CheckIcon aria-hidden className="size-4 shrink-0" />}<span className="min-w-0">{item.text}</span></span>
    {counting && <>
      <span aria-hidden>·</span>
      <button ref={undo} type="button" onClick={() => onUndo(item)} className="min-h-9 rounded-full bg-background/20 px-3 text-inherit hover:bg-background/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-foreground">Undo</button>
      <span aria-hidden>·</span>
      <span aria-hidden className="relative mr-1 inline-flex size-6 shrink-0 items-center justify-center text-[12px] font-semibold tabular-nums">
        <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - item.seconds! / UNDO_SECONDS)}
            className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none" /></svg>
        {item.seconds}
      </span>
    </>}
  </div>;
}

/**
 * The one place a wait shows: a black pill sticking at the top of the stream, under the pinned tabs, that
 * says what is going and counts down with Undo, then, once it is written, that it went. It takes no room of its own. The
 * live region stays mounted so a status is announced when it appears.
 */
export function SendPills({ items }: { items: readonly PillItem[] }) {
  const [undone, setUndone] = useState(false);
  const counting = items.some((item) => item.seconds !== undefined);
  useEffect(() => { if (counting) setUndone(false); }, [counting]);
  const undo = (item: PillItem) => { item.onUndo?.(); setUndone(true); };
  return <>
    {!!items.length && <div className="pointer-events-none sticky top-[4.25rem] z-30 flex h-0 flex-col items-center gap-2">
      {items.map((item) => <Pill key={item.id} item={item} onUndo={undo} />)}
    </div>}
    <div role="status" className="sr-only">{items.map((item) => <p key={item.id}>{item.status}</p>)}{!counting && undone && <p>Undone. Nothing was sent.</p>}</div>
  </>;
}
