// One Apps user text: Monica's words, verbatim (CONTRACT.md "Copy"). Every user-visible One Apps string lives here.

import type { OneAppId } from "./registry";

export const APP_NAMES: Readonly<Record<OneAppId, string>> = {
  capture: "Recording",
  "xyz.tinycloud.secrets": "Secrets",
  "xyz.tinycloud.opencredentials": "Credentials",
  "xyz.tinycloud.explorer": "Explorer",
  "xyz.tinycloud.account": "Account",
  "xyz.tinycloud.courier": "Courier",
};

export const APP_DESCRIPTIONS: Readonly<Record<OneAppId, string>> = {
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
  accountSummary: "your account summary",
  delegations: "the access you've given to apps and agents",
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
