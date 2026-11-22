// Every owner-visible string of the tiny bots surfaces (TC-2808). Copy goes to Monica from here.

/** The main bot's name until the owner renames it (TC-3790). Its key stays `main` in code, addresses and storage. */
export const MAIN_BOT_NAME = "TrustBot";
/** The main bot's name before TC-3790. No other bot may take it, so none is mistaken for the main one. */
export const MAIN_BOT_OLD_NAME = "Main";

export const BOTS_STRINGS = {
  ask: "What do you want done?",
  send: "Send",
  mainName: MAIN_BOT_NAME,
  mainHandle: `@${MAIN_BOT_NAME}`,
  working: (name: string) => `${name}, working`,
  openMain: `Open ${MAIN_BOT_NAME}'s chat`,
  messageMain: `Message ${MAIN_BOT_NAME}`,
  sendToMain: `Send to ${MAIN_BOT_NAME}`,
  modelLine: "Runs on a confidential model.",
  tryAgain: "Try again",
  historyLoading: "Loading earlier messages…",
  historyFailed: `Couldn't load your earlier messages with ${MAIN_BOT_NAME}.`,
  errors: {
    bot_unavailable: `${MAIN_BOT_NAME} couldn't start.`,
    model_unavailable: `${MAIN_BOT_NAME}'s model isn't answering. Try again later.`,
    busy: `${MAIN_BOT_NAME} is still working on your last message. Send this one when it replies.`,
    at_capacity: "{name} can't start right now because TinyCloud is running as many bots as it can. Your message wasn't sent. Try again shortly.",
    invalid: `That message is too long for ${MAIN_BOT_NAME}. Shorten it to 8,000 characters or fewer.`,
    signed_out: `Your session expired. Sign in again to talk to ${MAIN_BOT_NAME}.`,
    failed: `${MAIN_BOT_NAME}'s reply didn't come through.`,
  },
} as const;

export type BotsErrorCode = keyof typeof BOTS_STRINGS.errors;

/** The owner-visible line for an error; `name` is the bot's name, the main bot's until the bot view passes the real one. */
export function botsErrorText(code: BotsErrorCode, name: string = MAIN_BOT_NAME): string {
  return BOTS_STRINGS.errors[code].replace("{name}", name);
}

// Monica, TC-2808, 2026-11-12. Keep the disclosure in one constant for copy review.
export const HISTORY_EXPIRY_NOTICE = `Your TinyCloud permission expired on {expiryDate}. ${MAIN_BOT_NAME}'s chat history on our server will be deleted on {deletionDate}. Reconnect TinyCloud before then to save it to your space.`;
export const HISTORY_RECONNECT_LABEL = "Reconnect TinyCloud";

// Web access panel strings.
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const WEB_ACCESS_STRINGS = {
  title: "Web access",
  offDescription: `${MAIN_BOT_NAME} can't search the web or read pages.`,
  presets: {
    off: { label: "Off", description: `${MAIN_BOT_NAME} can't search the web or read pages.` },
    listed: { label: "Only sites you list", description: `${MAIN_BOT_NAME} searches and reads pages only on the sites you list.` },
    any: { label: "Search and read any public site", description: `${MAIN_BOT_NAME} can search the web and open any public page.` },
  },
  listLabel: `Sites ${MAIN_BOT_NAME} may use`,
  listHint: "One site per line, like docs.example.com. Subdomains are included. For shared domains like github.io, list your own site, like you.github.io.",
  listPlaceholder: "docs.example.com",
  listError: "Use site names like example.com, one per line, up to 50. Shared domains like github.io or co.uk need your own name in front, like you.github.io.",
  warningTitle: `Let ${MAIN_BOT_NAME} use the web?`,
  warningFace: "Using the web can be risky for your agent. Turn it on with care.",
  warningLearnMore: "Learn more",
  warningBody: `A web page can hide instructions meant for an AI. ${MAIN_BOT_NAME} might follow them and put things you've told it into a search or a web address. Searches go to our search provider, Tavily. Our server fetches pages, so the sites see our server, not you. Don't open or paste links ${MAIN_BOT_NAME} gives you unless you trust them.`,
  warningBodyAny: `This setting lets ${MAIN_BOT_NAME} open pages you've never seen, and any of them could try this. "Only sites you list" is safer, but anyone who can post on those sites could still try it.`,
  warningConfirm: "Turn on",
  warningCancel: "Not now",
  save: "Save",
  saving: "Saving…",
  unavailable: "Web access isn't working right now. Try again later.",
  loadFailed: `Couldn't load ${MAIN_BOT_NAME}'s web access setting. Reload the page to try again.`,
  saveFailed: `Couldn't save that, so ${MAIN_BOT_NAME}'s web access is unchanged. Try again.`,
  /** Today's use, or nothing yet (the line is hidden). */
  usageLine: (today: { searches: number; pages: number }) =>
    today.searches + today.pages === 0 ? "" : `Searched ${plural(today.searches, "time", "times")} and read ${plural(today.pages, "page", "pages")} today.`,
} as const;

// The bot view in the Chat slot (TC-3325). The same sentences as Main's chat above, with the bot's own name, so
// for Main they read exactly as they do today.
export const BOT_VIEW_STRINGS = {
  messageBot: (name: string) => `Message ${name}`,
  sendToBot: (name: string) => `Send to ${name}`,
  historyFailed: (name: string) => `Couldn't load your earlier messages with ${name}.`,
  errors: {
    bot_unavailable: (name: string) => `${name} couldn't start.`,
    model_unavailable: (name: string) => `${name}'s model isn't answering. Try again later.`,
    busy: (name: string) => `${name} is still working on your last message. Send this one when it replies.`,
    at_capacity: (name: string) => botsErrorText("at_capacity", name),
    invalid: (name: string) => `That message is too long for ${name}. Shorten it to 8,000 characters or fewer.`,
    signed_out: (name: string) => `Your session expired. Sign in again to talk to ${name}.`,
    failed: (name: string) => `${name}'s reply didn't come through.`,
  } satisfies Record<BotsErrorCode, (name: string) => string>,
  /** HISTORY_EXPIRY_NOTICE with the bot's own name. */
  historyExpiryNotice: (name: string) => HISTORY_EXPIRY_NOTICE.replace(`${MAIN_BOT_NAME}'s chat history`, `${name}'s chat history`),
  /** The bots under Chat in the navigation. */
  botsList: "Bots",
  newBot: "New bot",
  /** A bot's row when it replied while another bot was on screen. */
  unseen: (name: string) => `${name}, new reply`,
  // The Chat view choice in Settings: owner-approved copy, verbatim.
  chatView: {
    label: "Chat view",
    classic: "Classic",
    bots: "Bots",
    helper: "Classic shows one chat. Bots gives each bot its own chat.",
    notAdmitted: "Bots aren't available on this account. Classic chat works as before.",
  },
} as const;

// The activity lines and the bot's panel (TC-3325). Every word is in the plan's sections "Activity lines" and
// "Activity panel", except those marked as asked of the copy owner.
export const BOT_ACTIVITY_STRINGS = {
  ranCommands: (count: number) => (count === 1 ? "Ran 1 command" : `Ran ${count} commands`),
  changedFiles: (count: number) => (count === 1 ? "Changed 1 file" : `Changed ${count} files`),
  activity: "Activity",
  environment: "Environment",
  /** "Private · asleep"; "Regular" only for a bot whose environment says so. */
  environmentRow: (environment: "private" | "regular", awake: boolean) =>
    `${environment === "regular" ? "Regular" : "Private"} · ${awake ? "awake" : "asleep"}`,
  // For the copy owner: not in the plan.
  noActivity: "No activity",
  closePanel: "Close",
} as const;

export const CREATE_BOT_STRINGS = {
  title: "New bot",
  name: "Name your bot",
  shape: "Shape",
  colour: "Colour",
  cancel: "Cancel",
  create: "Create",
  creating: "Creating…",
  duplicate: "You already have a bot with that name.",
  invalidName: "Use 1 to 24 characters for your bot's name.",
  /** `mainName` is the main bot's name as the roster has it. */
  cap: {
    flat3: {
      count: (used: number, max: number) => `${used} of ${max} bots`,
      atLimit: (max: number, _hasOtherBot: boolean, mainName: string) => `You have ${max} bots, the most your account can have. Delete a bot other than ${mainName} to make a new one.`,
      refused: (max: number, _hasOtherBot: boolean, mainName: string) => `You already have ${max} bots. Delete a bot other than ${mainName} to make a new one.`,
    },
    table: {
      count: (used: number, max: number) => `${used} of ${max} private ${max === 1 ? "bot" : "bots"}`,
      atLimit: (max: number, hasOtherBot: boolean, mainName: string) => hasOtherBot
        ? `You have ${max} private ${max === 1 ? "bot" : "bots"}, the most your plan includes. Delete one other than ${mainName} to make a new one.`
        : max === 1 ? `Your plan includes ${max} private bot, and ${mainName} is it.` : "",
      refused: (max: number, hasOtherBot: boolean, mainName: string) => hasOtherBot
        ? `You already have ${max} private ${max === 1 ? "bot" : "bots"}, the most your plan includes. Delete one other than ${mainName} to make a new one.`
        : max === 1 ? `${mainName} is the only private bot your plan includes.` : "",
    },
  },
  failed: "Couldn't create your bot. Try again.",
  shapes: {
    pebble: "Pebble", sprout: "Sprout", drop: "Drop", clover: "Clover", bloom: "Bloom",
    cloud: "Cloud", ghost: "Ghost", bean: "Bean", comet: "Comet", petal: "Petal",
    squish: "Squish", moon: "Moon", star: "Star",
  },
  colours: {
    blue: "Blue", teal: "Teal", green: "Green", lime: "Lime", yellow: "Yellow",
    orange: "Orange", red: "Red", pink: "Pink", purple: "Purple", indigo: "Indigo", slate: "Slate",
  },
} as const;

// The bot panel's Edit and Delete bot (TC-3325). "Edit" and "Delete bot" are the plan's; the rest is for the copy owner.
export const BOT_MANAGE_STRINGS = {
  edit: "Edit",
  deleteBot: "Delete bot",
  save: "Save",
  saving: "Saving…",
  saveFailed: "Couldn't save your changes. Try again.",
  deleteTitle: (name: string) => `Delete ${name}?`,
  deleteBody: "Its history stays in your space.",
  deleting: "Deleting…",
  deleteFailed: "Couldn't delete your bot. Try again.",
} as const;

// Main's Meetings read setting (TC-3792). Dates arrive already formatted.
const MAIN = BOTS_STRINGS.mainName;
export const MEETINGS_ACCESS_STRINGS = {
  title: "Meetings",
  off: `${MAIN} can't read your meetings.`,
  allow: `Let ${MAIN} read them`,
  confirmTitle: `Let ${MAIN} read your meetings?`,
  confirmBody: `${MAIN} can read your recordings, transcripts and meeting notes for 7 days, then it stops. It can't change them. What it reads goes to the AI model service to write its answer. Once ${MAIN} reads a meeting, it can't use the web in this chat until the chat is cleared after 30 days without use.`,
  confirm: "Allow for 7 days",
  cancel: "Not now",
  on: (date: string) => `${MAIN} can read your meetings until ${date}.`,
  turnOff: "Turn off",
  ended: `${MAIN}'s access to your meetings has ended.`,
  failed: "Couldn't change this. Try again.",
} as const;
