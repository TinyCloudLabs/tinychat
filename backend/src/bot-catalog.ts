// TC-3325: the looks a bot can have. The frontend holds the same two lists in the same order, and a test on each side
// pins them, so a change here is a change on both sides.

export const BOT_SHAPES = ["pebble", "sprout", "drop", "clover", "bloom", "cloud", "ghost", "bean", "comet", "petal", "squish", "moon", "star"] as const;
export const BOT_COLOURS = ["blue", "teal", "green", "lime", "yellow", "orange", "red", "pink", "purple", "indigo", "slate"] as const;

export type BotShape = (typeof BOT_SHAPES)[number];
export type BotColour = (typeof BOT_COLOURS)[number];

export const isBotShape = (value: unknown): value is BotShape => BOT_SHAPES.some(shape => shape === value);
export const isBotColour = (value: unknown): value is BotColour => BOT_COLOURS.some(colour => colour === value);
