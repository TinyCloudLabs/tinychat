// Earlier (v1) chat history, moved onto the chat's own key only when the owner asks (TC-4225). Every string of this
// feature is here, apart from botsStrings.ts so they load with the action and not at boot.
export const EARLIER_HISTORY_STRINGS = {
  /** The separate action that asks for network-wide decrypt and moves earlier history. */
  move: "Move older history",
  moving: "Moving older history…",
  /** Shown beside the action while earlier history is held back (before the owner chooses to move it). */
  held: "Some older messages are hidden. Showing them needs access that also reads your Connectors secrets.",
  /** After the owner declined the request: the chat is unaffected, earlier history stays hidden. */
  declined: "Older messages stay hidden. Your chat works.",
  failed: "Couldn't move your older messages.",
  /** The OpenKey modal's description for the network-wide decrypt request. */
  approval: "Bot chat history: read your older messages so they move to this chat's own key. This access also reads your Connectors secrets.",
};
