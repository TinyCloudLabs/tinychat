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
