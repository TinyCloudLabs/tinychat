export const MESSAGING_STRINGS = {
  description: "Send a message to another bot and get its reply.",
  target: "The key of the bot to message.",
  text: "The message to send.",
  unavailable: "That bot is unavailable.",
  busy: "That bot is busy.",
  invalid: "Choose a bot from the list and send a message of up to 8,000 characters.",
  held: "This chat holds the owner's private data, so you can't message other bots from it. If propose_action is offered to you, propose the message there; it goes only after the owner taps Send.",
} as const;
