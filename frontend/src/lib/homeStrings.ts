// User-facing copy for the TinyCloud Home shell (TC-2040), worded by Monica.
// One module, so copy changes never touch components.

import { connectorOwnKeyGrants } from "./connectors/namedKeyWrites";
import { APP_NAME } from "./homeSite";

/** The name of the main screen, the one feed everything lands in. One constant, so a rename is one edit. */
export const SCREEN_NAME = "Feed";

/** Navigation labels. */
export const NAV_LABEL_RECORDING = "Recording";
export const NAV_LABEL_CHAT = "Chat";
export const NAV_LABEL_APPS = "Apps";
export const NAV_LABEL_FEED = "Feed";
export const NAV_LABEL_HOME = SCREEN_NAME;

/** The Home site's signed-out page (TC-2387). */
export const WELCOME_TITLE = APP_NAME;
export const WELCOME_LEAD = "Your agents post updates and ask for decisions here. You answer in one place, and everything stays in your own TinyCloud space.";
export const WELCOME_DEMO_NOTE = "Sample cards from sample agents. Answer one: nothing leaves this page.";
export const WELCOME_LEARN_MORE = "What is TinyCloud?";
export const WELCOME_AGENT_TITLE = "Let your agent share to your TinyCloud";
export const WELCOME_AGENT_BODY = "Paste this into Claude Code, Codex or any agent. It installs the TinyCloud CLI if needed, sets you up if you're new, and connects the agent to your TinyCloud One Feed.";
export const WELCOME_AGENT_PROMPT = "Fetch https://agents.tinycloud.xyz/feed with curl and follow it, including running its installer. Post the updates I ask for to my TinyCloud One Feed.";
export const WELCOME_AGENT_COPY = "Copy prompt";
export const WELCOME_AGENT_COPIED = "Copied";
export const WELCOME_AGENT_COPY_FAILED = "Select the prompt and copy it";
export const WELCOME_LEARN_MORE_LEAD = "New to TinyCloud?";

/** The Home site's empty feed (TC-2387). */
export const HOME_EMPTY_TITLE = "No cards yet";
export const HOME_EMPTY_BODY = `Ask your agent to post to your ${SCREEN_NAME}. Its updates and questions show up here.`;
export const HOME_EMPTY_HOW = "How agents post";
export const HOME_EMPTY_CHAT = "Open Chat";

/** The Apps page. */
export const APPS_PAGE_TITLE = "Apps";
export const APPS_PAGE_LEAD = "These apps open in TinyCloud Share, in a new tab. Share asks you to approve each app when you open it.";
export const APPS_LIST_LABEL = "Apps you can open in TinyCloud Share";
export const APPS_OPEN_IN_SHARE = "Open in Share";
export const APPS_OPENS_NEW_TAB = "opens in a new tab";
export const APPS_EMPTY = "No apps to show yet.";

/** The TinyCloud apps launcher (One Apps). */
export const APPS_LAUNCHER_TITLE = "TinyCloud apps";
export const APPS_PIN_HINT = "Pin an app to keep it one tap away.";
export const APPS_PIN = "Pin";
export const APPS_UNPIN = "Unpin";
export const appPinnedToast = (name: string) => `${name} pinned`;
export const appUnpinnedToast = (name: string) => `${name} unpinned`;
export const APPS_CONNECTORS_DESCRIPTION = "Connect Fireflies or Google Meet to bring in your meetings.";

/** A plain link on the signed-out sign-in surface to the product page. */
export const LANDING_LINK_LABEL = `About ${APP_NAME}`;

/** Connectors on the web asks for its own permission in place, when the owner opens it. */
export const FEATURE_ACCESS_TITLE = { connectors: "Allow Connectors" } as const;
/** What the approval covers: its own keys when Connectors opens its secrets with their own keys, else the whole network. */
const CONNECTORS_BODY_OWN_KEYS = `To sync your meetings, OpenKey will ask you to let ${APP_NAME} keep them in your TinyCloud space, along with the keys and sign-ins you add for Fireflies, Granola and Google Meet. Each is stored encrypted with its own key, and this approval opens only those keys.`;
const CONNECTORS_BODY_WHOLE_NETWORK = `To sync your meetings, OpenKey will ask you to let ${APP_NAME} keep them in your TinyCloud space, along with the keys and sign-ins you add for Fireflies, Granola and Google Meet, which are stored encrypted. To read those keys, ${APP_NAME} also asks to unlock everything encrypted to your account, including data other apps saved.`;
export const FEATURE_ACCESS_BODY = {
  // Read when shown, so it follows the same switch as the grant the approval asks for (connectorOwnKeyGrants).
  get connectors() { return connectorOwnKeyGrants() ? CONNECTORS_BODY_OWN_KEYS : CONNECTORS_BODY_WHOLE_NETWORK; },
};
/** The calm state after "Not now": the feature waits for permission, and Continue asks again. */
export const FEATURE_ACCESS_NEEDED = { connectors: "Connectors need your permission." } as const;
export const FEATURE_ACCESS_CONTINUE = "Continue";
export const FEATURE_ACCESS_NOT_NOW = "Not now";
/** Continue waits while a recording or an upload is running, so asking never cuts it off. */
export const FEATURE_ACCESS_BUSY = "Finish the current recording or upload first.";
export const FEATURE_ACCESS_DECLINED = "Permission wasn't given. Nothing changed.";
export const FEATURE_ACCESS_FAILED = "Couldn't ask for permission. Nothing changed. Try again.";
export const FEATURE_ACCESS_WRONG_ACCOUNT = "That was a different OpenKey account from the one signed in here. Nothing changed. Try again with the same account.";
/** Everything but the unlock-encrypted-data permission was allowed: the session was not kept, so nothing changed. */
export const FEATURE_ACCESS_PARTIAL = "Connectors can't read your saved keys without permission to unlock your encrypted data, so nothing changed. To try again, select Continue and allow that permission.";
/** A new recording or upload waits while OpenKey is open for one of these asks. */
export const FEATURE_ACCESS_WAIT_FOR_OPENKEY = "Finish in OpenKey first, then try again.";

/** Older connector keys: saved before each had its own encryption key, so opening them takes one short approval (words: Monica). */
export const LEGACY_KEYS_TITLE = "Move your older connector keys";
export const LEGACY_KEYS_BODY = `Connector keys and secrets you saved earlier are encrypted with your account's main key. To move them to their own encryption keys, OpenKey asks you to let ${APP_NAME} open everything encrypted with your main key for 1 hour. This is asked once: after the move, Connectors uses only their own keys.`;
export const LEGACY_KEYS_MOVED = "Your older connector keys and secrets are moved to their own encryption keys.";
export const LEGACY_KEYS_NOTHING = "There were no older connector keys to move.";
export const LEGACY_KEYS_DECLINED = "Your older connector keys weren't moved. Connectors asks next time you open it.";
export const LEGACY_KEYS_FAILED = "Your older connector keys couldn't be moved.";
export const LEGACY_KEYS_RETRY = "Try again";
/** The words OpenKey shows beside the one-hour permission. */
export const LEGACY_KEYS_APPROVAL_DESCRIPTION = "Open everything encrypted with your account's main key for 1 hour, including older connector keys and saved secrets, so they can move to their own encryption keys.";
