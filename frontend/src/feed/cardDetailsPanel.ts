// What Details adds beyond the card's facts: the shapes that decide what a card does not draw (its "+N") and the lists
// that show it, with the card as sent. Loaded beside the app rather than in its startup chunk (CardActions.tsx), so
// they cost nothing at boot (frontend/scripts/entry-size-check.ts).
export { cardUnshown } from "./unshownCard";
export { CardData, FeedUsedList, UnshownList } from "./UnshownList";
