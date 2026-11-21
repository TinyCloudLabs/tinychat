// Every user-visible One Apps string lives here.

import type { OpenKeyFailure } from "../lib/authErrors";
import { FEATURE_ACCESS_FAILED, FEATURE_ACCESS_WRONG_ACCOUNT } from "../lib/homeStrings";
import type { GlyphId } from "./icons";
import type { LinkAppId, OneAppId } from "./registry";

export const APP_NAMES: Readonly<Record<OneAppId, string>> = {
  capture: "Recording",
  "xyz.tinycloud.secrets": "Secrets",
  "xyz.tinycloud.opencredentials": "Credentials",
  "xyz.tinycloud.explorer": "Explorer",
  "xyz.tinycloud.account": "Account",
  "xyz.tinycloud.courier": "Courier",
  "xyz.tinycloud.share": "Share",
};

export const APP_DESCRIPTIONS: Readonly<Record<Exclude<OneAppId, LinkAppId>, string>> = {
  capture: "Record or upload a meeting and get its transcript.",
  "xyz.tinycloud.secrets": "Keep API keys, passwords and environment variables encrypted.",
  "xyz.tinycloud.opencredentials": "Store and share verifiable credentials with OpenCredentials.",
  "xyz.tinycloud.explorer": "Browse what's in your TinyCloud: spaces, tables and stored items.",
  // Web. iOS leaves Account out of ONE_APPS (registry.ts), so its iOS wording is unused.
  "xyz.tinycloud.account": "See your account, billing, spaces, installed apps and the access you've given.",
  "xyz.tinycloud.courier": "See what your agents send each other, and answer what needs you.",
};

/** The `<scope>` phrase for each group of ceiling entries (registry.ts tags every entry with one). */
export const SCOPE_PHRASES = {
  secrets: "your secrets",
  variables: "your environment variables",
  secretsAppData: "the Secrets app's own data",
  capabilityList: "the list of access it already has",
  credentials: "your credentials",
  appsData: "the data your apps keep in TinyCloud",
  publicSpace: "your public space",
  secretNames: "the names of your secrets and variables, not their values",
  installedApps: "your installed apps",
  spaces: "the list of your spaces",
  courier: "your Courier threads and messages, the agents you've paired and requests waiting for you",
} as const;

export type ScopeId = keyof typeof SCOPE_PHRASES;

/** The phrase that always ends a list, whatever order the scopes come in. */
const LAST: ScopeId = "secretNames";

/** Joins scope phrases without a serial comma ("A and B", "A, B and C"); duplicates once, `secretNames` last. */
export function joinScopes(scopes: readonly ScopeId[]): string {
  const unique = [...new Set(scopes)];
  const ordered = [...unique.filter((id) => id !== LAST), ...unique.filter((id) => id === LAST)];
  const phrases = ordered.map((id) => SCOPE_PHRASES[id]);
  if (phrases.length <= 1) return phrases.join("");
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

export const askTitle = (app: string) => `${app} needs more access`;
export const askBody = (app: string, scope: string) => `${app} wants access to ${scope}. You approve it in OpenKey.`;
export const ASK_CONTINUE = "Continue in OpenKey";
export const ASK_NOT_NOW = "Not now";
export const askDeclined = (app: string) => `${app} can't do this without that access.`;
/** The phone app can't ask OpenKey for more (its session never signs); web One offers "Continue in OpenKey" for the same ask. */
export const askNotInApp = (app: string) => `${app} needs more access. To allow it, open ${app} in One on the web.`;

/** Why a step-up added nothing: "Not now", OpenKey's own outcome, or another account picked in OpenKey. */
export type StepUpFailure = OpenKeyFailure | { kind: "declined" } | { kind: "wrong-account" };

/**
 * The line after a step-up that added nothing. Outcomes another try can fix say "Try again"; a refusal, a decline or
 * an ended session say the app can't go on without the access.
 */
export function stepUpFailedLine(app: string, failure: StepUpFailure): string {
  switch (failure.kind) {
    case "wrong-account": return FEATURE_ACCESS_WRONG_ACCOUNT;
    case "popup-blocked":
    case "failed": return FEATURE_ACCESS_FAILED;
    default: return askDeclined(app);
  }
}

export const ASK_CLOSE = "Close";

/**
 * What One says when an app asks for a space that isn't set up, keyed by space name:
 * `open` names the app people open to set it up; `courier` is Courier's own line; `silent` says nothing.
 * `applications` cannot be missing (One's sign-in creates it), so it is silent too.
 */
export const MISSING_SPACE_COPY: Readonly<Record<string, { kind: "open"; name: string } | { kind: "courier" } | { kind: "silent" }>> = {
  secrets: { kind: "open", name: "Secrets" },
  credentials: { kind: "open", name: "Credentials" },
  account: { kind: "open", name: "Account" },
  agents: { kind: "courier" },
  public: { kind: "silent" },
  applications: { kind: "silent" },
};

/** "A and B", "A, B and C". */
const joinNames = (names: readonly string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The line for missing spaces that belong to other apps; undefined when there are none. */
function otherSpacesLine(app: string, names: readonly string[], none: boolean): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) {
    const [space] = names;
    return none
      ? `${app} uses ${space}, which isn't set up in your TinyCloud. Open ${space} once to set it up, then come back to give ${app} access.`
      : `${app} also uses ${space}, which isn't set up in your TinyCloud. Open ${space} once to set it up, then come back to give ${app} access to it.`;
  }
  return none
    ? `${app} uses ${joinNames(names)}, which aren't set up in your TinyCloud. Open each once to set it up, then come back to give ${app} access.`
    : `${app} also uses ${joinNames(names)}, which aren't set up in your TinyCloud. Open each once to set it up, then come back to give ${app} access to them.`;
}

/**
 * The line for the missing spaces that have an app to open, or undefined when none do. `none`: nothing the app
 * asked for exists (the line replaces the ask body); otherwise it goes under the body. The app's own space comes first.
 */
export function missingSpacesLine(app: string, spaces: readonly string[], none: boolean): string | undefined {
  const names = [...new Set(spaces.flatMap((space) => {
    const copy = MISSING_SPACE_COPY[space];
    return copy?.kind === "open" ? [copy.name] : [];
  }))];
  const others = otherSpacesLine(app, names.filter((name) => name !== app), none);
  if (!names.includes(app)) return others;
  const own = `${app} isn't set up in your TinyCloud. Open ${app} once to set it up, then come back to give it access.`;
  return others ? `${own} ${others}` : own;
}

/** Courier's line when its space (agents) is missing; "Open Courier" links to Courier's own page in a new tab. */
export const COURIER_MISSING = {
  before: "Courier starts working once you connect an agent to it. ",
  link: "Open Courier",
  after: " to see how, then come back to give Courier access.",
} as const;

export const courierMissing = (spaces: readonly string[]) => spaces.some((space) => MISSING_SPACE_COPY[space]?.kind === "courier");

// The launcher, the open app bar, the phone's pill and the Add an app page (TC-3650).

/** The launcher tile's short line under the name, from 640 px. */
export const APP_CAPTIONS: Readonly<Record<GlyphId, string>> = {
  recording: "Record and transcribe",
  secrets: "Keys and passwords",
  credentials: "Proofs you hold",
  explorer: "Browse your data",
  account: "Plan, spaces and access",
  courier: "Messages with agents",
  share: "Share files by link",
  connectors: "Bring in your meetings",
};

export const CONNECTORS_NAME = "Connectors";

export const pinApp = (app: string) => `Pin ${app}`;
export const unpinApp = (app: string) => `Unpin ${app}`;

/**
 * An app One can't frame here: its screen's heading and button. `phone`: the iOS and Android apps, which open the page
 * in an in-app browser view (feed/inAppLink.ts), not a tab.
 */
export const opensSeparatelyTitle = (app: string, phone: boolean) => (phone ? `${app} opens in a browser window` : `${app} opens in its own tab`);
export const openSeparately = (app: string, phone: boolean) => (phone ? `Open ${app}` : "Open in new tab");

/**
 * The first navigation item's name with One Apps on: the pill's spoken label and the sidebar and rail row. Still open
 * (Feed or Home); tests import it, never the word.
 */
export const MAIN_TAB_LABEL = "Feed";

/** The phone pill's other spoken labels (its items are icon-only). */
export const PILL_LABELS = { chat: "Chat", apps: "Apps", you: "You" } as const;

export const ADD_APP_TITLE = "Add an app";
export const ADD_APP_LEAD =
  "Build your own TinyCloud app with the coding agent you already use. Copy this prompt into Claude Code, Codex or another agent and tell it what the app should do.";
export const ADD_APP_REVIEW_NOTE = "The TinyCloud team reviews new apps before they're listed.";
/** Whether the Add an app page shows ADD_APP_REVIEW_NOTE under its lead line. */
export const SHOW_REVIEW_NOTE = true;
export const ADD_APP_PROMPT_LABEL = "Prompt";
export const COPY_PROMPT = "Copy prompt";
export const COPIED = "Copied";
export const COPY_FAILED = "Copy unavailable. Select the prompt above and copy it manually.";
