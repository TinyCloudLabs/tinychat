// The view of the "Move earlier history" action loads when it is first shown: most owners never see it.
import { lazy, Suspense } from "react";
import { useEarlierHistoryHeld, type EarlierHistoryMove } from "./earlierHistory";

const View = lazy(() => import("./EarlierHistoryAction").then(module => ({ default: module.EarlierHistoryAction })));

export function LazyEarlierHistoryAction({ move }: { move: EarlierHistoryMove }) {
  const held = useEarlierHistoryHeld(move.bot);
  return held ? <Suspense fallback={null}><View move={move} /></Suspense> : null;
}
