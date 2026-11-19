// How a tapped card opens. A phone-width screen, or any touch screen, opens it in place in the stream; a wide screen
// with a mouse lifts it into a card over the stream (DesktopCard.tsx). One query decides, so every place that opens or
// folds a card agrees.
import { useSyncExternalStore } from "react";

/** Tailwind's `lg` and up, with a fine pointer. */
export const DESKTOP_CARD_QUERY = "(min-width: 1024px) and (pointer: fine)";

function subscribe(change: () => void) {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(DESKTOP_CARD_QUERY);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
const current = () => typeof matchMedia === "function" && matchMedia(DESKTOP_CARD_QUERY).matches;

/** True where an opened card lifts over the stream; false where it opens in place. Follows a resize live. */
export function useDesktopCard(): boolean {
  return useSyncExternalStore(subscribe, current, () => false);
}
