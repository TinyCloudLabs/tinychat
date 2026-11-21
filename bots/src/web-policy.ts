// The owner's web-access setting for Main, and the one place that decides which sites it covers. The setting is
// held by the supervisor in the bot's data directory (outside anything a sandbox mounts), pushed to the gateway,
// and enforced by the gateway on every call; the sandbox never sees it and cannot change it.

import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards";
import type { BotLayout } from "./layout";

export const WEB_MODES = ["off", "listed", "any"] as const;
export type WebMode = (typeof WEB_MODES)[number];

export interface WebPolicy {
  mode: WebMode;
  /** Lowercase ASCII host names; used only when mode is "listed". Subdomains of an entry are covered. */
  hosts: string[];
}

export const OFF: WebPolicy = { mode: "off", hosts: [] };
export const MAX_HOSTS = 50;
const MAX_HOST_CHARS = 253;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export const INVALID_HOSTS = "Use site names like example.com, one per line, up to 50. Shared domains like github.io or co.uk need your own name in front, like you.github.io.";

/**
 * Hosts that are not one site but a place anyone can publish under (a public suffix or a hosting platform's own
 * domain). Listing one would cover every tenant, so it is refused; one tenant's own name (`me.github.io`) is fine.
 * Not the full public suffix list: it names the platforms we know of, plus the country second levels below.
 */
const SHARED_HOSTS = new Set([
  "github.io", "githubusercontent.com", "github.dev", "gitlab.io", "bitbucket.io", "sourceforge.io", "codeberg.page", "pages.dev",
  "workers.dev", "r2.dev", "netlify.app", "vercel.app", "now.sh", "herokuapp.com", "appspot.com", "web.app", "firebaseapp.com",
  "blogspot.com", "wordpress.com", "tumblr.com", "substack.com", "notion.site", "glitch.me", "repl.co", "replit.app", "onrender.com",
  "fly.dev", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "pythonanywhere.com", "wixsite.com", "weebly.com",
  "myshopify.com", "ghost.io", "readthedocs.io", "surge.sh", "deno.dev", "hf.space", "neocities.org", "itch.io", "ngrok.io",
  "ngrok-free.app", "trycloudflare.com", "duckdns.org", "vercel.dev",
]);
const COUNTRY_SECOND_LEVELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "nom", "ltd", "plc"]);

/** Whether `host` is itself a shared place (see SHARED_HOSTS) or a country's second level such as `co.uk`. */
export function sharedHost(host: string): boolean {
  if (SHARED_HOSTS.has(host)) return true;
  const labels = host.split(".");
  return labels.length === 2 && labels[1]!.length === 2 && COUNTRY_SECOND_LEVELS.has(labels[0]!);
}

/**
 * A host name an owner may list: ASCII letters, digits, hyphens and dots, at least two labels, not an IP address
 * (every label of an IPv4 address is numeric, and no real top-level domain is), not `localhost`, not a shared
 * place anyone can publish under. Non-ASCII names are refused: they can pass for another site. Returns the lowercase name, or undefined.
 */
export function listedHost(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.length < 3 || host.length > MAX_HOST_CHARS) return undefined;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every(label => LABEL.test(label))) return undefined;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return undefined;
  if (sharedHost(host)) return undefined;
  return host;
}

/** A policy from untrusted JSON, or undefined. Hosts are lowercased and de-duplicated; any bad entry refuses all. */
export function parseWebPolicy(input: unknown): WebPolicy | undefined {
  if (!isRecord(input) || !WEB_MODES.includes(input.mode as WebMode)) return undefined;
  const mode = input.mode as WebMode;
  if (!Array.isArray(input.hosts) || input.hosts.length > MAX_HOSTS) return undefined;
  const hosts = new Set<string>();
  for (const entry of input.hosts) {
    const host = listedHost(entry);
    if (host === undefined) return undefined;
    hosts.add(host);
  }
  return { mode, hosts: mode === "listed" ? [...hosts] : [] };
}

/** Whether `host` is one of the listed sites or a subdomain of one. */
export function hostListed(policy: WebPolicy, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return policy.hosts.some(listed => name === listed || name.endsWith(`.${listed}`));
}

/** Where a bot's setting lives, beside (not inside) its state snapshot. */
export function webSettingsFile(layout: BotLayout): string {
  return join(layout.dataDir, "web.json");
}

/** The saved setting. A missing, unreadable or malformed file is "off": the safe reading, never an error. */
export function readWebPolicy(layout: BotLayout): WebPolicy {
  const file = webSettingsFile(layout);
  try {
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return OFF;
    return parseWebPolicy(JSON.parse(readFileSync(file, "utf8"))) ?? OFF;
  } catch {
    return OFF;
  }
}

/** Saves the setting: a temporary file, fsynced, renamed into place. Throws if the data directory is missing. */
export function writeWebPolicy(layout: BotLayout, policy: WebPolicy): void {
  const file = webSettingsFile(layout);
  const fresh = `${file}.new`;
  const handle = openSync(fresh, "w", 0o600);
  try {
    writeSync(handle, JSON.stringify(policy));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(fresh, file);
}
