// Earlier (v1) chat history, moved onto the chat's own key only when the owner asks (TC-4225). Every string of this
// feature is here, apart from botsStrings.ts so they load with the action and not at boot.
export const EARLIER_HISTORY_STRINGS = {
  /** The separate action that asks for network-wide decrypt and moves earlier history. */
  move: "Move earlier history",
  moving: "Moving earlier history…",
  /** Shown beside the action while earlier history is held back (before the owner chooses to move it). */
  held: "Some earlier messages are hidden until you move them.",
  /** After the owner declined the request: the chat is unaffected, earlier history stays hidden. */
  declined: "Earlier messages stay hidden. Your chat works.",
  failed: "Couldn't move your earlier messages.",
  /** The OpenKey modal's description for the network-wide decrypt request. */
  approval: "Read your earlier chat history with bots so it can move to the chat's own key.",
};
