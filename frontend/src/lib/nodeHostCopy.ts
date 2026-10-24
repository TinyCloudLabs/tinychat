// Every user-facing string for the "Your own node" setting, the first-use node
// confirmation, the refusal and the forget dialog. The wording is final copy:
// change it only with the copy owner. The saved node ID DETECTS a different node
// at an address; the copy says no more than that.
//
// {address} is the saved address (e.g. http://127.0.0.1:8000); {id} is the
// node's full ID; {short} is its first and last 4 characters.

export const NODE_SETTING_SECTION_LABEL = "Your own node";
export const NODE_SETTING_FIELD_LABEL = "Node address";
export const NODE_SETTING_PLACEHOLDER = "http://127.0.0.1:8000";
export const NODE_SETTING_HELP =
  "Use a TinyCloud node running on this computer instead of Exo's default. For a computer only you use.";
/** The second help line under the field. The text between backticks is a command and is rendered as code. */
export const NODE_SETTING_CORS_HELP = "Start your node with `TINYCLOUD_CORS=true` so Exo can reach it.";
export const NODE_SETTING_SAVE = "Save";
export const NODE_SETTING_USE_DEFAULT = "Use the default";

export const NODE_LIMITS_HEADING = "What doesn't work with a node on your computer";
export const NODE_LIMITS_INTRO = "These need Exo's online service, so they're off while your own node is set:";
export const NODE_LIMITS_ITEMS = [
  "Connecting meeting services such as Fireflies and Google Meet",
  "Connecting your agent",
  "Syncing with the Exo mailbox",
] as const;
export const NODE_LIMITS_CLOSING = "Your notes and other data on your node work as usual.";

export const NODE_CONFIRM_TITLE = "Is this your node?";
export const nodeConfirmBody = (address: string) => `Exo found a TinyCloud node at ${address} with this ID:`;
/** The sentence after the ID. The text between backticks is a command and is rendered as code. */
export const nodeConfirmCompare = (address: string) =>
  `To compare, run \`curl ${address}/info\` on this computer. Exo remembers this ID and detects a different node at this address.`;
export const NODE_CONFIRM_CONFIRM = "Confirm";
export const NODE_CONFIRM_CANCEL = "Cancel";

export const nodeRefusal = (address: string) =>
  `Exo detected a different TinyCloud node at ${address}. Nothing was sent. If you reinstalled your node on purpose, forget the saved node ID in Settings.`;

export const NODE_FORGET_BUTTON = "Forget saved node ID";
export const NODE_FORGET_TITLE = "Forget the saved node ID?";
export const nodeForgetSavedLine = (savedId: string) => `Saved ID: ${savedId}`;
export const nodeForgetNowLine = (currentId: string) => `Now at this address: ${currentId}`;
export const nodeForgetSignOutLine = (address: string) =>
  `You'll be signed out of ${address}. The next time Exo connects, it asks you to confirm the node again.`;
export const NODE_FORGET_CONFIRM = "Forget";
export const NODE_FORGET_CANCEL = "Cancel";

export const nodeStatusLocal = (address: string, short: string) =>
  `This computer: using your node at ${address} (ID ${short})`;
export const NODE_STATUS_DEFAULT = "This computer: using the default";

export const nodeUnreachable = (address: string) => `Can't reach your node at ${address}. Check that it's running.`;
/** Signing in to a node on this computer failed in a way that points at how the node was started. Backticks: code. */
export const nodeSignInFailed = (address: string) =>
  `Couldn't sign in to your node at ${address}. Check that it was started with \`TINYCLOUD_CORS=true\`.`;

/** The one line by a control that is off while the node address is set; it links to the "Your own node" section of Settings. */
export const NODE_DISABLED_LINE = "Not available while Exo uses your own node.";

/** {short}: the first and last 4 characters of the node's full ID. */
export function shortNodeId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}
