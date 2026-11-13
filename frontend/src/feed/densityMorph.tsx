// The card morph (Sam, 11-12): when a card opens in place or folds back to a row, its box grows or shrinks to its
// new size while its content crossfades. A row and an open card are different components, so the morph happens one
// level up, on the list item: the item animates its box (motion's `layout`), and the old content fades out while the
// new fades in. The technique follows the motion density demo (Aceternity's Expandable Card idea); the code is the
// app's own.
//
// Wiring, in short:
//   <MorphConfig>                                    one around every list of cards (and anything between them)
//     <ul>…<MorphItem key={key} contentKey={open ? "full" : "compact"} data-card-key={key}>…</MorphItem>…</ul>
//   </MorphConfig>
import { type ReactNode, type Ref, useRef } from "react";
import { AnimatePresence, LayoutGroup, LazyMotion, MotionConfig, type Transition, m, useIsPresent, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/** One tween for every box in the morph. */
const LAYOUT_TWEEN: Transition = { duration: 0.4, ease: [0.2, 0, 0, 1] };
/** With reduced motion, boxes jump straight to their new size. */
const INSTANT: Transition = { duration: 0 };
/**
 * The old content leaves fast, before the box has shrunk much, so a tall card never hangs over the cards below;
 * the new content arrives a moment later, while the box is still growing. Both well inside the box's tween.
 */
const FADE_IN: Transition = { duration: 0.15, delay: 0.08, ease: "easeOut" };
const FADE_OUT: Transition = { duration: 0.12, ease: "easeIn" };

/** motion's animation features (motionFeatures.ts), fetched once Home has rendered. */
const loadMotionFeatures = () => import("./motionFeatures").then((module) => module.default);

/**
 * Around the whole feed: its `m` components render at once and start animating when motion's features arrive, so
 * that code is not in the entry chunk the app boots from (TC-2882).
 */
export function MotionFeatures({ children }: { children: ReactNode }) {
  return <LazyMotion features={loadMotionFeatures}>{children}</LazyMotion>;
}

/**
 * Wrap every list of cards in one of these (one wrapper around all of them, not one per list).
 * - `LayoutGroup`: when any card changes, every card in the group measures itself, so cards in other lists and
 *   further down slide to their new places instead of jumping.
 * - `MotionConfig reducedMotion="user"`: with the system's reduce-motion setting on, boxes jump and only fades
 *   remain. MorphItem already does this on its own; this covers anything else animated inside the lists.
 */
export function MorphConfig({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user"><LayoutGroup>{children}</LayoutGroup></MotionConfig>;
}

export type MorphItemProps = {
  /** Which version of the card is showing ("compact", "full", "post"). A new key crossfades old content into new. */
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
 * old content, an open card still growing); the rest of the time it does not, so focus rings stay whole.
 */
export function MorphItem({ contentKey, children, className, ...attributes }: MorphItemProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLLIElement>(null);
  return <m.li ref={ref} {...attributes} layout transition={{ layout: reduce ? INSTANT : LAYOUT_TWEEN }}
    onLayoutAnimationStart={() => ref.current?.setAttribute("data-morphing", "")}
    onLayoutAnimationComplete={() => ref.current?.removeAttribute("data-morphing")}
    // `relative`: the leaving content is positioned against the item while it fades.
    className={cn("relative data-[morphing]:overflow-clip", className)}>
    <AnimatePresence initial={false} mode="popLayout">
      <MorphContent key={contentKey} reduce={!!reduce}>{children}</MorphContent>
    </AnimatePresence>
  </m.li>;
}

/**
 * One version of a card's content. `layout="position"` makes it follow the item's box without being stretched by
 * it. Content on its way out takes no taps or focus and is hidden from screen readers (`inert`). With reduced
 * motion it leaves at once, so it never sits over the cards below; the new content still fades in.
 */
function MorphContent({ children, reduce, ref }: { children: ReactNode; reduce: boolean; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return <m.div ref={ref} layout="position" inert={!present}
    transition={{ layout: reduce ? INSTANT : LAYOUT_TWEEN }}
    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: FADE_IN }} exit={{ opacity: 0, transition: reduce ? INSTANT : FADE_OUT }}>
    {children}
  </m.div>;
}
