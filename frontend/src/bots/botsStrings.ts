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
  cap: {
    flat3: {
      count: (used: number, max: number) => `${used} of ${max} bots`,
      atLimit: (max: number) => `You have ${max} bots, the most your account can have. Delete a bot other than Main to make a new one.`,
      refused: (max: number) => `You already have ${max} bots. Delete a bot other than Main to make a new one.`,
    },
    table: {
      count: (used: number, max: number) => `${used} of ${max} private ${max === 1 ? "bot" : "bots"}`,
      atLimit: (max: number, hasOtherBot: boolean) => hasOtherBot
        ? `You have ${max} private ${max === 1 ? "bot" : "bots"}, the most your plan includes. Delete one other than Main to make a new one.`
        : max === 1 ? `Your plan includes ${max} private bot, and Main is it.` : "",
      refused: (max: number, hasOtherBot: boolean) => hasOtherBot
        ? `You already have ${max} private ${max === 1 ? "bot" : "bots"}, the most your plan includes. Delete one other than Main to make a new one.`
        : max === 1 ? "Main is the only private bot your plan includes." : "",
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
