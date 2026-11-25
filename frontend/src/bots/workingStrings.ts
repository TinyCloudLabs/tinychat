// Every line the working indicator shows while a bot works (TC-4382). Each line names what the bot is doing; none
// carries words from the bot or from a page. The words went through copy review on 2026-11-25.
import type { BotStep } from "./botsApi";

/** Shown when no step is known and while the bot thinks between steps. */
const GENERIC = "Working on it…";

export const WORKING_STRINGS = {
  generic: GENERIC,
  // No ellipsis: this one waits on the reader.
  approval: "Waiting for your approval",
  readingSite: (site: string) => `Reading ${site}…`,
  readingPage: "Reading a page…",
  steps: {
    thinking: GENERIC,
    // The bot is making a card for the owner; the approval line takes over once the card is there.
    request: GENERIC,
    search: "Searching the web…",
    writing: "Writing the reply…",
    commands: "Running a command…",
    files: "Working with files…",
    secret: "Using a saved secret…",
    meetings: "Using your meetings…",
    feed: "Using your feed…",
    chats: "Using your chats…",
    telegram: "Using your Telegram chats…",
    bot_message: "Asking another bot…",
    tool: "Using a tool…",
  } satisfies Record<Exclude<BotStep, "read_page"> | "writing", string>,
};
