// Opening a row on a phone: one row open at a time; while one is open the others dim and the open one comes to just
// under the sticky heading.

/** The rows that are not the open one, while a row is open: dimmed to 38 %, eased at the same pace as the grow. Reduced motion dims at once. */
export const FOCUS_DIM_CLASS = "transition-opacity duration-350 ease-smooth motion-reduce:transition-none data-[dim]:opacity-[.38]";

/**
 * An opened card's parts rise in one after the other (the grow's stagger). The animation only holds its first frame
 * while it waits, so nothing keeps a transform afterwards; reduced motion skips it.
 */
export const OPEN_STAGGER_CLASS = "motion-safe:[&_article>*]:animate-grow-in motion-safe:[&_article>:nth-child(2)]:[animation-delay:50ms] motion-safe:[&_article>:nth-child(3)]:[animation-delay:100ms] motion-safe:[&_article>:nth-child(n+4)]:[animation-delay:150ms]";

/**
 * Where a node's top sits in the scroller's content, from layout alone: unlike getBoundingClientRect it ignores the
 * transform a row is still animating with, so it is where the row will rest.
 */
export function topInScroller(node: HTMLElement, root: HTMLElement): number {
  const documentTop = (element: HTMLElement) => {
    let top = 0;
    for (let current: HTMLElement | null = element; current; current = current.offsetParent as HTMLElement | null) top += current.offsetTop;
    return top;
  };
  return documentTop(node) - documentTop(root);
}
