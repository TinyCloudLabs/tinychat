// Sam, 11-12: the Compact ↔ Full morph. When the feed changes density, every card on screen grows or
// shrinks to its new size while its content crossfades, and the card you were reading stays where it was on
// screen. A compact card and a full card are different components, so the morph happens one level up, on the
// list item: the item animates its box (motion's `layout`), and the old content fades out while the new fades in.
// The technique follows the motion density demo (Aceternity's Expandable Card idea, applied to every card at
// once, plus a scroll anchor); the code is the app's own.
//
// Wiring, in short:
//   <MorphConfig>                                    one around every list of cards (and anything between them)
//     <ul>…<MorphItem key={key} contentKey={open ? "full" : "compact"} data-card-key={key}>…</MorphItem>…</ul>
//   </MorphConfig>
//   const anchoredToggle = useAnchoredToggle(mainRef);
//   anchoredToggle(() => { setSize(next); });
import { type ReactNode, type Ref, type RefObject, useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, LayoutGroup, MotionConfig, type Transition, cancelFrame, cubicBezier, frame, motion, useIsPresent, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/** One tween for every box in the morph, so the scroll anchor knows when it ends and can follow it exactly. */
const MORPH_SECONDS = 0.4;
const MORPH_EASE: [number, number, number, number] = [0.2, 0, 0, 1];
const LAYOUT_TWEEN: Transition = { duration: MORPH_SECONDS, ease: MORPH_EASE };
/** With reduced motion, boxes jump straight to their new size. */
const INSTANT: Transition = { duration: 0 };
/**
 * The old content leaves fast, before the box has shrunk much, so a tall card never hangs over the cards below;
 * the new content arrives a moment later, while the box is still growing. Both well inside the box's tween.
 */
const FADE_IN: Transition = { duration: 0.15, delay: 0.08, ease: "easeOut" };
const FADE_OUT: Transition = { duration: 0.12, ease: "easeIn" };
/** The anchor card follows the same curve as the boxes, so it lands in step with them. */
const easeMorph = cubicBezier(...MORPH_EASE);
/** A card counts as "the one you are reading" once this much of it shows below the top edge. */
const MIN_VISIBLE_PX = 24;

/**
 * Wrap every list of cards in one of these (one wrapper around all of them, not one per list).
 * - `LayoutGroup`: when any card changes, every card in the group measures itself, so cards in other lists and
 *   further down slide to their new places instead of jumping.
 * - `MotionConfig reducedMotion="user"`: with the system's reduce-motion setting on, boxes jump and only fades
 *   remain. MorphItem already does this on its own; this covers anything else animated inside the lists.
 * The scroll container needs no `layoutScroll`: the anchor reads where the card is on screen every frame.
 */
export function MorphConfig({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user"><LayoutGroup>{children}</LayoutGroup></MotionConfig>;
}

/**
 * Something between the cards that is not a card (a section heading, a "Show more" row). Inside MorphConfig it
 * glides to its new place with the cards around it; without it, it would jump there and sit over cards that are
 * still moving. Optional.
 */
export function MorphShift({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return <motion.div layout="position" transition={{ layout: reduce ? INSTANT : LAYOUT_TWEEN }} className={className}>{children}</motion.div>;
}

export type MorphItemProps = {
  /** Which version of the card is showing ("compact", "full"). A new key crossfades old content into new. */
  contentKey: string;
  children: ReactNode;
  className?: string;
} & {
  /** `data-*` attributes reach the `<li>` (the feed finds cards by `data-card-key`). */
  [attribute: `data-${string}`]: string | number | boolean | undefined;
};

/**
 * A card in the list, as an `<li>` that morphs. When its size changes (its content changed, or cards around it
 * did), the item animates from its old box to its new one. When `contentKey` changes, the old content is lifted
 * out of the layout and fades while the new content fades in, each drawn at its true size: the box's scale is
 * undone for the content, so text is never stretched. While the box moves it clips what spills out of it (the
 * old content, a full card still growing); the rest of the time it does not, so focus rings stay whole.
 */
export function MorphItem({ contentKey, children, className, ...attributes }: MorphItemProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLLIElement>(null);
  return <motion.li ref={ref} {...attributes} layout transition={{ layout: reduce ? INSTANT : LAYOUT_TWEEN }}
    onLayoutAnimationStart={() => ref.current?.setAttribute("data-morphing", "")}
    onLayoutAnimationComplete={() => ref.current?.removeAttribute("data-morphing")}
    // `relative`: the leaving content is positioned against the item while it fades.
    className={cn("relative data-[morphing]:overflow-clip", className)}>
    <AnimatePresence initial={false} mode="popLayout">
      <MorphContent key={contentKey} reduce={!!reduce}>{children}</MorphContent>
    </AnimatePresence>
  </motion.li>;
}

/**
 * One version of a card's content. `layout="position"` makes it follow the item's box without being stretched by
 * it. Content on its way out takes no taps or focus and is hidden from screen readers (`inert`). With reduced
 * motion it leaves at once, so it never sits over the cards below; the new content still fades in.
 * `h-full` lets a grid tile still fill its row.
 */
function MorphContent({ children, reduce, ref }: { children: ReactNode; reduce: boolean; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return <motion.div ref={ref} layout="position" inert={!present} className="h-full"
    transition={{ layout: reduce ? INSTANT : LAYOUT_TWEEN }}
    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: FADE_IN }} exit={{ opacity: 0, transition: reduce ? INSTANT : FADE_OUT }}>
    {children}
  </motion.div>;
}

export type AnchorOptions = {
  /**
   * Where the readable area starts. An element: the bottom edge of the sticky header it is in (or is), inside the
   * scroll container, wherever that header is now (slid out of view, it adds nothing). A number: that many pixels
   * below the container's top. Default: the container's top.
   */
  stickyTop?: RefObject<HTMLElement | null> | number;
};

/** The box of the sticky element `node` is in (or is), below `container`; `node`'s own box if there is none. */
function stickyBox(node: HTMLElement, container: HTMLElement): DOMRect {
  for (let at: HTMLElement | null = node; at && at !== container; at = at.parentElement) {
    if (getComputedStyle(at).position === "sticky") return at.getBoundingClientRect();
  }
  return node.getBoundingClientRect();
}

/**
 * Changes the feed's density (or anything else that resizes every card) without losing your place: the card you
 * are reading stays where it is on screen, the cards above it grow or shrink upwards and the cards below move down.
 *
 * Returns `anchoredToggle(change)`. It finds the first card (`li[data-card-key]` in the scroll container) whose top
 * shows below the top (below `stickyTop`), notes where it is on screen, holds the content's height so the container
 * cannot shrink and clamp the scroll mid-morph, and applies `change` straight away (flushSync). Then, every frame
 * after motion has drawn, it scrolls the container by however far that card has moved, until the card's own
 * animation has finished. When one card fills the view and no top shows, that card (with at least 24px showing) is
 * the one held: it eases down to just below the top instead (its `scroll-margin-top`, or 8px), so a long card that
 * shrinks lands in view.
 *
 * Why every frame, not once: motion starts the morph a frame or two after the change and moves the card over
 * about 400ms, so a single correction (or a timer) would leave it drifting. Scrolling or touching the feed during
 * the morph hands control back to you. Reduced motion: the change is instant and the scroll is corrected once,
 * before the next paint. At the very top of the feed nothing needs holding, so `change` simply runs.
 *
 * Limit: near the end of a short feed, shrinking cards can leave too little below to hold the card in place; the
 * browser then clamps the scroll when the morph ends.
 */
export function useAnchoredToggle(mainRef: RefObject<HTMLElement | null>, options: AnchorOptions = {}): (change: () => void) => void {
  const { stickyTop } = options;
  const reduce = useReducedMotion();
  // Stops the morph being followed, if one is.
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  return useCallback((change: () => void) => {
    stopRef.current?.();
    const main = mainRef.current;
    if (!main || main.scrollTop <= 0) { change(); return; }

    const mainBox = main.getBoundingClientRect();
    const line = typeof stickyTop === "number" ? mainBox.top + stickyTop
      : stickyTop?.current ? Math.max(mainBox.top, stickyBox(stickyTop.current, main).bottom) : mainBox.top;
    // The card you are reading: the first whose top shows, so it and everything below it hold still while the
    // cards above it change size. Only when one card fills the view (no top shows) is that card the anchor.
    const cards = [...main.querySelectorAll<HTMLElement>("li[data-card-key]")];
    const anchor = cards.find((node) => {
      const box = node.getBoundingClientRect();
      return box.top >= line && box.top < mainBox.bottom;
    }) ?? cards.find((node) => {
      const box = node.getBoundingClientRect();
      return box.bottom >= line + MIN_VISIBLE_PX && box.top < mainBox.bottom;
    });
    const key = anchor?.dataset.cardKey;
    if (!anchor || key === undefined) { change(); return; }

    const startTop = anchor.getBoundingClientRect().top;
    const endTop = startTop < line ? line + (parseFloat(getComputedStyle(anchor).scrollMarginTop) || 8) : startTop;
    // The card may move to another list (and so another element) when it changes.
    const find = (current: HTMLElement) => current.isConnected ? current
      : [...main.querySelectorAll<HTMLElement>("li[data-card-key]")].find((node) => node.dataset.cardKey === key);

    if (reduce) {
      flushSync(change);
      const after = find(anchor);
      if (after) main.scrollBy({ top: after.getBoundingClientRect().top - endTop, behavior: "instant" });
      return;
    }

    // Hold the height of the container's content (the child of the container the card sits in), so shrinking
    // cards leave space at the very end for the length of the morph rather than pulling the scroll back.
    let content: HTMLElement = anchor;
    while (content.parentElement && content.parentElement !== main) content = content.parentElement;
    const heldMinHeight = content.style.minHeight;
    content.style.minHeight = `${content.offsetHeight}px`;

    flushSync(change);

    let node: HTMLElement | undefined = anchor;
    let started: number | undefined;
    let frames = 0;
    const durationMs = MORPH_SECONDS * 1000;
    const follow = ({ timestamp }: { timestamp: number }) => {
      node = node && find(node);
      if (!node) { stop(); return; }
      started ??= timestamp;
      const elapsed = timestamp - started;
      const progress = Math.min(1, elapsed / durationMs);
      const target = startTop + (endTop - startTop) * easeMorph(progress);
      const drift = node.getBoundingClientRect().top - target;
      if (Math.abs(drift) > 0.5) main.scrollBy({ top: drift, behavior: "instant" });
      frames += 1;
      // motion clears the card's transform when its morph ends; the time limit covers a morph that never starts.
      const settled = !node.style.transform || node.style.transform === "none";
      if ((frames > 2 && progress >= 1 && settled) || elapsed > durationMs + 1000) stop();
    };
    const stop = () => {
      cancelFrame(follow);
      content.style.minHeight = heldMinHeight;
      main.removeEventListener("wheel", stop);
      main.removeEventListener("pointerdown", stop);
      stopRef.current = null;
    };
    main.addEventListener("wheel", stop, { passive: true });
    main.addEventListener("pointerdown", stop, { passive: true });
    stopRef.current = stop;
    frame.postRender(follow, true);
  }, [mainRef, stickyTop, reduce]);
}
