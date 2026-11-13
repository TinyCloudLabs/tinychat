// Sam, 11-12: the feed's header (the "Home" title and the view slider) slides out of the way when you
// scroll down to read and comes back as soon as you scroll up, the way Aceternity's Floating Navbar behaves, rebuilt
// for a feed. Unlike the original it starts visible, measures pixels rather than a fraction of the page, and follows
// the feed's own scroll container, because the page itself never scrolls. It moves by transform only, so the cards
// under it never reflow. A plain scroll listener is enough here; no animation library is needed.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/utils";

// How far you must keep scrolling in one direction before the header reacts, so a slow finger drift doesn't make
// it flicker.
const THRESHOLD_PX = 8;

export function FloatingHeader({ scrollRef, children, className }: { scrollRef: RefObject<HTMLElement | null>; children: ReactNode; className?: string }) {
  const headerRef = useRef<HTMLDivElement>(null);
  // Where the header sits in the page; once that spot is scrolled away, the header is stuck over the cards.
  const spotRef = useRef<HTMLDivElement>(null);
  const [hiddenByScroll, setHiddenByScroll] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // Stuck over the cards, it comes back slimmer (design round 6): it slides up so the part marked `data-float-keep`
  // (the slider and the toolbar) sits at the top and the rest (the title) is out of view. Scrolled down, it slides
  // further, so only the part marked `data-float-pin` (the toolbar) stays at the top: Filter and View stay in reach
  // without moving the list (QA cb784d4, B1). Its height never changes, so the cards below never jump.
  const [stuck, setStuck] = useState(false);
  const [keepAt, setKeepAt] = useState(0);
  const [pinAt, setPinAt] = useState(0);
  const [focusInside, setFocusInside] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let last = scroller.scrollTop;
    // Distance travelled in the current direction; it resets whenever the direction flips.
    let travel = 0;
    const onScroll = () => {
      const top = scroller.scrollTop;
      const delta = top - last;
      last = top;
      setScrolled(top > 0);
      const spot = spotRef.current;
      setStuck(!!spot && spot.getBoundingClientRect().top < scroller.getBoundingClientRect().top - 1);
      const keep = headerRef.current?.querySelector<HTMLElement>("[data-float-keep]");
      setKeepAt(keep ? Math.max(0, keep.offsetTop - 8) : 0);
      const pin = headerRef.current?.querySelector<HTMLElement>("[data-float-pin]");
      setPinAt(pin ? Math.max(0, pin.offsetTop - 3) : 0);
      // Near the top there's room for the header without covering anything, so it always shows. This also covers
      // iOS rubber-banding, where scrollTop briefly goes negative.
      if (top < (headerRef.current?.offsetHeight ?? 0)) {
        travel = 0;
        setHiddenByScroll(false);
        return;
      }
      // The feed scrolling itself to hold a card in place while the cards morph (densityMorph marks it) is not you
      // scrolling: the header stays as it is, so the card it holds stays clear of it.
      if (scroller.hasAttribute("data-anchoring")) { travel = 0; return; }
      if (delta === 0) return;
      travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
      if (travel > THRESHOLD_PX) setHiddenByScroll(true);
      else if (travel < -THRESHOLD_PX) setHiddenByScroll(false);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  // Someone tabbing into the header must be able to see what they're on, so keyboard focus inside always shows it.
  // A tap on the slider also focuses it, but that must not pin the header for the rest of the scroll.
  const hidden = hiddenByScroll && !focusInside;
  // Hidden with a pinned part: slid up just far enough that the pinned part sits at the top.
  const pinned = hidden && stuck && pinAt > 0;
  const shift = pinned ? pinAt : !hidden && stuck ? keepAt : 0;

  return <>
    <div ref={spotRef} aria-hidden className="h-0" />
    <div ref={headerRef} data-hidden={hidden || undefined} data-stuck={stuck || undefined}
      style={shift ? { transform: `translateY(-${shift}px)` } : undefined}
      onFocus={(event) => setFocusInside((event.target as HTMLElement).matches(":focus-visible"))}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false); }}
      className={cn(
        // Opaque (design round 6): with a translucent blur, card text showed through under "Home" in dark WebKit.
        "group sticky top-0 z-10 border-b bg-background transition-[transform,border-color,box-shadow] duration-200 ease-smooth motion-reduce:transition-none",
        // The hairline and soft shadow only appear once cards are passing under the header; at rest it sits flat on
        // the page.
        scrolled ? "border-border shadow-[0_1px_8px_-4px_rgb(0_0_0/0.12)] dark:shadow-[0_1px_8px_-4px_rgb(0_0_0/0.5)]" : "border-transparent",
        hidden && !pinned ? "-translate-y-full" : "translate-y-0",
        className,
      )}>
      {children}
    </div>
  </>;
}
