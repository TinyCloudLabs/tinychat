// The Feed is one stream: Needs you, Updates, Pending and History, one under the other. The island over it is the stream's map.

export type StreamSection = "needs" | "updates" | "history";

/** Where a section heading stops: under the header's pinned row (its bottom is 55 px when the header is hidden, 60 when it is shown over it), in px. */
export const STREAM_STICKY_TOP = 55;

/** The room under the last row, so even the last section can come up to its heading's place: 460 px at least, and a screen less the heading and one row. */
export const STREAM_ROOM_CLASS = "h-[max(460px,calc(100dvh-12rem))]";

/** The top of the list that the header's pinned row and a stuck heading cover, in px: an opened card is brought under it. */
export const STREAM_COVER_PX = 100;

/** A section heading: it stays under the pinned row while its section scrolls, over a hairline, translucent. */
export const STREAM_HEADING_CLASS = "sticky top-[55px] z-[5] -mx-3 mb-2 flex items-baseline justify-between border-b border-border bg-background/90 px-4 py-2 text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground backdrop-blur sm:-mx-6 sm:px-7 lg:-mx-8 lg:px-9";
