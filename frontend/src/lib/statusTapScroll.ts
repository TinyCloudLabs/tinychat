/**
 * Status-bar tap on the iPhone app scrolls the page to the top.
 *
 * The app shell is a fixed-height box whose screens scroll inside their own `overflow-y: auto` element, so the
 * document never scrolls. WKWebView's own scroll-to-top only moves the document, which is why the tap did nothing.
 * The native shell (ExoBridgeViewController) forwards the tap as a `statusTap` window event; this scrolls the
 * scroller the person is looking at.
 */

export const STATUS_TAP_EVENT = "statusTap";

const SCROLLABLE_OVERFLOW = /^(auto|scroll|overlay)$/;

/** Whether `element` is a scroller that has been scrolled down (the document counts through its scrolling element). */
function isScrolledDown(element: Element, doc: Document, win: Window): boolean {
  if (element === doc.documentElement || element === doc.body) {
    return (doc.scrollingElement?.scrollTop ?? 0) > 0;
  }
  return element.scrollTop > 0 && SCROLLABLE_OVERFLOW.test(win.getComputedStyle(element).overflowY);
}

/**
 * The outermost scrolled-down scroller among `start` and its ancestors, or null when the layer under the finger is
 * already at the top. Outermost, so a scrolled list inside a scrolled screen takes two taps like any iOS app's
 * nested scrollers; a sheet or dialog is a separate branch of the document, so it never reaches the page behind it.
 */
export function scrollerToReset(start: Element | null, doc: Document = document, win: Window = window): Element | null {
  let found: Element | null = null;
  for (let element = start; element; element = element.parentElement) {
    if (isScrolledDown(element, doc, win)) found = element;
  }
  if (found === doc.documentElement || found === doc.body) return doc.scrollingElement ?? found;
  return found;
}

function elementAtViewportCenter(win: Window): Element | null {
  const doc = win.document;
  return doc.elementFromPoint?.(win.innerWidth / 2, win.innerHeight / 2) ?? null;
}

/** Scrolls the scroller under the middle of the screen back to its top. Returns it, or null when none was scrolled down. */
export function scrollToTopOnStatusTap(
  win: Window = window,
  elementAtCenter: (win: Window) => Element | null = elementAtViewportCenter,
): Element | null {
  const scroller = scrollerToReset(elementAtCenter(win), win.document, win);
  if (!scroller) return null;
  const reduceMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  scroller.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  return scroller;
}

/** Listens for the native shell's `statusTap` event. Returns the function that stops listening. */
export function installStatusTapScroll(win: Window = window): () => void {
  const onStatusTap = () => {
    scrollToTopOnStatusTap(win);
  };
  win.addEventListener(STATUS_TAP_EVENT, onStatusTap);
  return () => win.removeEventListener(STATUS_TAP_EVENT, onStatusTap);
}
