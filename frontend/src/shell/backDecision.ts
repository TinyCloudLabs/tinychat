// What Android's hardware Back does, as a pure function (useAndroidBack.ts
// carries it out). In order: close the top sheet, dialog or popover; leave a
// pushed screen (through history when there is some, else to its parent);
// return to the home destination from another tab; and at home, minimise the
// app. Never exit: the app is one tap away, recording or not.

import { destinationOf, isPushed, parentPath, type Destination, type Screen } from "./routes";
import type { SizeClass } from "../lib/sizeClass";

export type BackAction =
  | { kind: "dismiss-overlay" }
  | { kind: "history-back" }
  | { kind: "navigate"; to: string; replace: true }
  | { kind: "minimize" };

export interface BackInput {
  /** A sheet, dialog or popover is open on top. */
  overlay: boolean;
  screen: Screen;
  size: SizeClass;
  /** react-router's history index (`history.state.idx`); 0 or less when there is nothing to go back to. */
  historyIdx: number;
  homeDestination: Destination;
  homePath: string;
}

export function decideBack(input: BackInput): BackAction {
  const { overlay, screen, size, historyIdx, homeDestination, homePath } = input;
  if (overlay) return { kind: "dismiss-overlay" };
  if (isPushed(screen, size) && historyIdx > 0) return { kind: "history-back" };
  if (isPushed(screen, size)) return { kind: "navigate", to: parentPath(screen) ?? homePath, replace: true };
  if (destinationOf(screen) !== homeDestination) return { kind: "navigate", to: homePath, replace: true };
  return { kind: "minimize" };
}
