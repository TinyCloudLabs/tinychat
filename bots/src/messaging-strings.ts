export const MESSAGING_STRINGS = {
  description: "Send a message to another bot and get its reply.",
  target: "The key of the bot to message.",
  text: "The message to send.",
  unavailable: "That bot is unavailable.",
  busy: "That bot is busy.",
  invalid: "Choose a bot from the list and send a message of up to 8,000 characters.",
  held: "This chat holds the owner's private data, so you can't message other bots from it.",
  targetHeld: "That bot isn't taking messages from other bots right now, so it won't reply. Don't send it again.",
  oneBot: "You can message one bot per message from the owner. To send a message to several bots, propose it with propose_action.",
} as const;
