// The secrets the gateway knows by name: which service each belongs to, the one site it may be used with, and the one
// header its value may go in. Taken from TinyCloud Secrets' provider list (secret-manager src/lib/provider-catalog.ts),
// only the entries whose API site that list names. For these the site and the header come from here, never from
// Main; any other name is an unknown secret, used only with the sites Main named and the owner approved.
// `request_secret` reads this table for the sites; `call_with_secret` enforces the header and the methods from it.

import { listedHost } from "./web-policy";

/** Every approved secret may be used to read. */
export const READ_METHODS = ["GET", "HEAD"] as const;
/** Calls that can change things or cost money: only for a known secret whose entry lists them, never an unknown one. */
export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];
export type Method = (typeof READ_METHODS)[number] | WriteMethod;

export interface KnownSecret {
  /** The service's name as the owner sees it, from TinyCloud Secrets' list. */
  service: string;
  site: string;
  /** The only header the value may go in, and what comes before the value in it. */
  header: { name: string; prefix: string };
  /** Write methods allowed besides GET and HEAD; the secret card tells the owner. Only where the API needs them. */
  writes?: readonly WriteMethod[];
}

const BEARER = { name: "authorization", prefix: "Bearer " } as const;
// These APIs do their work (a reply, speech, a GraphQL query) only through POST.
const POST = ["POST"] as const;

export const KNOWN_SECRETS: Readonly<Record<string, KnownSecret>> = {
  OPENAI_API_KEY: { service: "OpenAI", site: "api.openai.com", header: BEARER, writes: POST },
  ANTHROPIC_API_KEY: { service: "Anthropic", site: "api.anthropic.com", header: { name: "x-api-key", prefix: "" }, writes: POST },
  GEMINI_API_KEY: { service: "Google Gemini", site: "generativelanguage.googleapis.com", header: { name: "x-goog-api-key", prefix: "" }, writes: POST },
  ELEVENLABS_API_KEY: { service: "ElevenLabs", site: "api.elevenlabs.io", header: { name: "xi-api-key", prefix: "" }, writes: POST },
  RESEND_API_KEY: { service: "Resend", site: "api.resend.com", header: BEARER },
  FIREFLIES_API_KEY: { service: "Fireflies", site: "api.fireflies.ai", header: BEARER, writes: POST },
  GITHUB_TOKEN: { service: "GitHub PAT", site: "api.github.com", header: BEARER },
};

export const knownSecret = (name: string): KnownSecret | undefined => Object.hasOwn(KNOWN_SECRETS, name) ? KNOWN_SECRETS[name] : undefined;

/** The write methods a secret may be used with: its catalog entry's, none for an unknown secret. */
export const writeMethods = (name: string): readonly WriteMethod[] => knownSecret(name)?.writes ?? [];

/** Every method a secret may be used with: GET and HEAD, then the entry's writes. */
export const allowedMethods = (name: string): readonly Method[] => [...READ_METHODS, ...writeMethods(name)];

/** A secret's name: capital letters, digits and underscores, starting with a letter, at most 64 characters. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SITES = 3;

/** Names that only ever mean a private network. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "intranet", "corp"];

/**
 * A site Main may name for an unknown secret: a public host name as the web setting takes one (no address, port,
 * path, `localhost` or shared domain), and not under a name that only means a private network. Lowercase, or undefined.
 * Where a public name points is checked again when the call is made.
 */
export function secretSite(input: unknown): string | undefined {
  if (typeof input !== "string" || /[/:@?#\s]/.test(input)) return undefined;
  const host = listedHost(input);
  if (host === undefined || PRIVATE_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return undefined;
  return host;
}

/** 1 to 3 distinct sites, each a `secretSite`; undefined if any is not. */
export function secretSites(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SITES) return undefined;
  const sites = input.map(secretSite);
  if (sites.includes(undefined)) return undefined;
  return [...new Set(sites as string[])];
}

/** "a", "a and b", "a, b and c": how Main's messages name the sites. */
export function joinSites(sites: readonly string[]): string {
  return sites.length <= 1 ? (sites[0] ?? "") : `${sites.slice(0, -1).join(", ")} and ${sites[sites.length - 1]}`;
}
