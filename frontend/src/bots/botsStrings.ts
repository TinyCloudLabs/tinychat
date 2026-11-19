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
    at_capacity: "{name} can't start right now because TinyCloud is running as many bots as it can. Your message wasn't sent. Try again shortly.",
    invalid: "That message is too long for Main. Shorten it to 8,000 characters or fewer.",
    signed_out: "Your session expired. Sign in again to talk to Main.",
    failed: "Main's reply didn't come through.",
  },
} as const;

export type BotsErrorCode = keyof typeof BOTS_STRINGS.errors;

/** The owner-visible line for an error; `name` is the bot's name, Main until the bot view passes the real one. */
export function botsErrorText(code: BotsErrorCode, name: string = BOTS_STRINGS.mainName): string {
  return BOTS_STRINGS.errors[code].replace("{name}", name);
}

// Monica, TC-2808, 2026-11-12. Keep the disclosure in one constant for copy review.
export const HISTORY_EXPIRY_NOTICE = "Your TinyCloud permission expired on {expiryDate}. Main's chat history on our server will be deleted on {deletionDate}. Reconnect TinyCloud before then to save it to your space.";
export const HISTORY_RECONNECT_LABEL = "Reconnect TinyCloud";

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
  /** For a bot other than Main: HISTORY_EXPIRY_NOTICE with the bot's name. */
  historyExpiryNotice: (name: string) => HISTORY_EXPIRY_NOTICE.replace("Main's chat history", `${name}'s chat history`),
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
