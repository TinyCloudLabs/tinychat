// The Feed is one stream: Needs you, Updates, Pending and History, one under the other. The island over it is the stream's map.

export type StreamSection = "needs" | "updates" | "history";

/** Where a section heading stops under the header's pinned row (the island and Filter), in px. */
export const STREAM_STICKY_TOP = 60;

/** The room under the last row, so even the last section can come up to its heading's place. */
export const STREAM_ROOM_PX = 460;

/** The top of the list that the header's pinned row and a stuck heading cover, in px: an opened card is brought under it. */
export const STREAM_COVER_PX = 100;

/** A section heading: it stays under the pinned row while its section scrolls, over a hairline, translucent. */
export const STREAM_HEADING_CLASS = "sticky top-[60px] z-[5] -mx-3 mb-2 flex items-baseline justify-between border-b border-border bg-background/90 px-4 py-2 text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground backdrop-blur sm:-mx-6 sm:px-7 lg:-mx-8 lg:px-9";
