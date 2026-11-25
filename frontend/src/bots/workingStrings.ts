// DRAFT-FOR-MONICA
// Every line the working indicator shows while a bot works (TC-4382). Each line names what the bot is doing; none
// carries words from the bot or from a page. Lines marked "Monica" are hers as written; the "Using …" lines are drafts.
import type { BotStep } from "./botsApi";

/** Monica, TC-4382, 2026-11-25. Shown when no step is known and while the bot thinks between steps. */
const GENERIC = "Working on it…";

export const WORKING_STRINGS = {
  generic: GENERIC,
  // Monica, TC-4382, 2026-11-25. No ellipsis: this one waits on the reader.
  approval: "Waiting for your approval",
  // Monica, TC-4382, 2026-11-25.
  readingSite: (site: string) => `Reading ${site}…`,
  readingPage: "Reading a page…",
  steps: {
    thinking: GENERIC,
    // The bot is making a card for the owner; the approval line takes over once the card is there.
    request: GENERIC,
    // Monica, TC-4382, 2026-11-25.
    search: "Searching the web…",
    writing: "Writing the reply…",
    // Drafts: "Using <tool in plain words>…", one per kind of tool.
    commands: "Using its computer…",
    files: "Using its files…",
    secret: "Using a saved secret…",
    meetings: "Using your meetings…",
    feed: "Using your feed…",
    chats: "Using your chats…",
    telegram: "Using your Telegram chats…",
    bot_message: "Using another bot…",
    tool: "Using a tool…",
  } satisfies Record<Exclude<BotStep, "read_page"> | "writing", string>,
};
