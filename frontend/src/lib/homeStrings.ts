// User-facing copy for the TinyCloud Home shell (TC-2040), worded by Monica.
// One module, so copy changes never touch components.

/** Navigation labels. */
export const NAV_LABEL_RECORDING = "Recording";
export const NAV_LABEL_CHAT = "Chat";
export const NAV_LABEL_APPS = "Apps";
export const NAV_LABEL_FEED = "Feed";
export const NAV_LABEL_HOME = "Home";

/** The Home site's signed-out page (TC-2387). */
export const WELCOME_TITLE = "TinyCloud Home";
export const WELCOME_LEAD = "Your agents post updates and ask for decisions here. You answer in one place, and everything stays in your own TinyCloud space.";
export const WELCOME_DEMO_NOTE = "Sample cards from sample agents. Answer one: nothing leaves this page.";
export const WELCOME_LEARN_MORE = "What is TinyCloud?";
export const WELCOME_AGENT_TITLE = "Let your agent share to your TinyCloud";
export const WELCOME_AGENT_BODY = "Paste this into Claude Code, Codex or any agent. It installs the TinyCloud CLI if needed, sets you up if you're new, and connects the agent to your Home feed.";
export const WELCOME_AGENT_PROMPT = "Fetch https://agents.tinycloud.xyz/feed with curl and follow it, including running its installer. Post the updates I ask for to my TinyCloud Home feed.";
export const WELCOME_AGENT_COPY = "Copy prompt";
export const WELCOME_AGENT_COPIED = "Copied";
export const WELCOME_AGENT_COPY_FAILED = "Select the prompt and copy it";
export const WELCOME_LEARN_MORE_LEAD = "New to TinyCloud?";

/** The Home site's empty feed (TC-2387). */
export const HOME_EMPTY_TITLE = "No cards yet";
export const HOME_EMPTY_BODY = "Ask your agent to post to your Home. Its updates and questions show up here.";
export const HOME_EMPTY_HOW = "How agents post";
export const HOME_EMPTY_CHAT = "Open Chat";

/** The Apps page. */
export const APPS_PAGE_TITLE = "Apps";
export const APPS_PAGE_LEAD = "These apps open in TinyCloud Share, in a new tab. Share asks you to approve each app when you open it.";
export const APPS_LIST_LABEL = "Apps you can open in TinyCloud Share";
export const APPS_OPEN_IN_SHARE = "Open in Share";
export const APPS_OPENS_NEW_TAB = "opens in a new tab";
export const APPS_EMPTY = "No apps to show yet.";

/** A plain link on the signed-out sign-in surface to the landing page at /about. */
export const LANDING_LINK_LABEL = "About TinyCloud Home";

/** Recording and Connectors on the Home site ask for their own permissions in place, when the owner opens them. */
export const FEATURE_ACCESS_TITLE = { recording: "Allow Recording", connectors: "Allow Connectors" } as const;
export const FEATURE_ACCESS_BODY = {
  recording: "To save your recordings, transcripts and summaries, OpenKey will ask you to let TinyCloud Home keep them in your space, with an AssemblyAI key if you add one.",
  connectors: "To sync your meetings, OpenKey will ask you to let TinyCloud Home keep them in your space, with the keys you add for Fireflies, Granola and Google Meet.",
} as const;
/** The calm state after "Not now": the feature waits for permission, and Continue asks again. */
export const FEATURE_ACCESS_NEEDED = { recording: "Recording needs your permission.", connectors: "Connectors needs your permission." } as const;
export const FEATURE_ACCESS_CONTINUE = "Continue";
export const FEATURE_ACCESS_NOT_NOW = "Not now";
/** Continue waits while a recording or an upload is running, so asking never cuts it off. */
export const FEATURE_ACCESS_BUSY = "Finish the current recording or upload first.";
export const FEATURE_ACCESS_DECLINED = "Permission wasn't given. Nothing changed.";
export const FEATURE_ACCESS_FAILED = "Couldn't ask for permission. Nothing changed. Try again.";
