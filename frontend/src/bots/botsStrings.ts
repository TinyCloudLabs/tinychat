// Every owner-visible string of the tiny bots surfaces (TC-2808). Copy goes to Monica from here.
export const BOTS_STRINGS = {
  ask: "What do you want done?",
  send: "Send",
  mainName: "Main",
  mainHandle: "@Main",
  working: (name: string) => `${name}, working`,
  openMain: "Open Main's chat",
  messageMain: "Message Main",
  sendToMain: "Send to Main",
  modelLine: "Runs on a confidential model.",
  tryAgain: "Try again",
  historyFailed: "Couldn't load your earlier messages with Main.",
  errors: {
    bot_unavailable: "Main couldn't start.",
    model_unavailable: "Main's model isn't answering. Try again later.",
    busy: "Main is still working on your last message. Send this one when it replies.",
    invalid: "That message is too long for Main. Shorten it to 8,000 characters or fewer.",
    signed_out: "Your session expired. Sign in again to talk to Main.",
    failed: "Main's reply didn't come through.",
  },
} as const;

export type BotsErrorCode = keyof typeof BOTS_STRINGS.errors;

// Monica, TC-2808, 2026-11-12. Keep the disclosure in one constant for copy review.
export const HISTORY_EXPIRY_NOTICE = "Your TinyCloud permission expired on {expiryDate}. Main's chat history on our server will be deleted on {deletionDate}. Reconnect TinyCloud before then to save it to your space.";
export const HISTORY_RECONNECT_LABEL = "Reconnect TinyCloud";

// Main's web access setting. Draft copy, under review: every owner-visible string of the setting lives here.
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const WEB_ACCESS_STRINGS = {
  title: "Web access",
  offDescription: "Main can't search the web or read pages.",
  presets: {
    off: { label: "Off", description: "Main can't search the web or read pages." },
    listed: { label: "Only sites I list", description: "Main searches and reads pages only on the sites you list." },
    any: { label: "Search and read any public site", description: "Main can search the web and open any public page." },
  },
  listLabel: "Sites Main may use",
  listHint: "One site per line, like docs.example.com. Subdomains are included. For shared domains like github.io, list your own site, like you.github.io.",
  listPlaceholder: "docs.example.com",
  listError: "Use site names like example.com, one per line, up to 50. Shared domains like github.io or co.uk need your own name in front, like you.github.io.",
  warningTitle: "Let Main use the web?",
  warningBody: "A web page can hide instructions meant for an AI. Main might follow them and put things you've told it into a search or a web address. Searches go to our search provider, Tavily. Pages are fetched by our server, so the site sees our server, not you. Don't open or paste links Main gives you unless you trust them.",
  warningBodyAny: "This setting lets Main open pages you've never seen, and any of them could try this. \"Only sites I list\" is safer, but anyone who can post on those sites could still try it.",
  warningConfirm: "Turn on",
  warningCancel: "Not now",
  save: "Save",
  saving: "Saving…",
  unavailable: "Web access isn't working right now. Try again later.",
  loadFailed: "Couldn't load Main's web access setting. Reload the page to try again.",
  saveFailed: "Couldn't save that, so Main's web access is unchanged. Try again.",
  /** Today's use, or nothing yet (the line is hidden). */
  usageLine: (today: { searches: number; pages: number }) =>
    today.searches + today.pages === 0 ? "" : `Searched ${plural(today.searches, "time", "times")} and read ${plural(today.pages, "page", "pages")} today.`,
} as const;
