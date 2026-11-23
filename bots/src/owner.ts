import { createHash, timingSafeEqual } from "node:crypto";

/** The only owner form the backend sends: did:pkh on chain 1 with the lowercased address. */
export const OWNER_DID = /^did:pkh:eip155:1:0x[0-9a-f]{40}$/;
export const BOT_ID = /^[0-9a-f]{64}$/;
/** How an owner's bots are named: `main`, or the 32 hex characters the backend chose when it created the bot. */
export const MAIN_KEY = "main";
export const BOT_KEY = /^[0-9a-f]{32}$/;
/** The main bot's name as the owner sees it, until the backend sends the name the owner gave it (TC-3790). */
export const MAIN_BOT_NAME = "TrustBot";
/** The longest bot name the backend's registry takes. */
const BOT_NAME_MAX = 24;

/**
 * The bot's name from a backend message: one line of 1 to 24 characters with no control or line-break character,
 * trimmed. Anything else is undefined, and the prompt keeps MAIN_BOT_NAME. A name only words the prompt; it is never
 * a source of trust, which comes from the bot's key.
 */
export function botNameFrom(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || [...name].length > BOT_NAME_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return undefined;
  return name;
}

/** A path segment that names a bot: `main` or a sibling key. Checked before any id or path is built from it. */
export function isBotKey(value: string): boolean {
  return value === MAIN_KEY || BOT_KEY.test(value);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time string equality (hashing first makes the comparison independent of length). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Matches `Authorization: Bearer <secret>` in constant time. */
export function bearerMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return sameSecret(header.slice("Bearer ".length), secret);
}

/**
 * A bot's stable id. Main's is sha256 of the owner DID, as it always was; a sibling's is sha256 of the owner DID,
 * a newline and its key. A DID holds no newline and a key is 32 hex characters, so the two parts cannot run
 * together. Paths are built from this, never from the DID.
 */
export function botIdFor(ownerDid: string, key: string = MAIN_KEY): string {
  if (key === MAIN_KEY) return digest(ownerDid).toString("hex");
  if (!BOT_KEY.test(key)) throw new Error("invalid bot key");
  return digest(`${ownerDid}\n${key}`).toString("hex");
}

/** A well-formed owner DID whose address is on the service's own account allowlist. */
export function ownerAllowed(owner: string, accounts: Set<string> | "*"): boolean {
  if (!OWNER_DID.test(owner)) return false;
  return accounts === "*" || accounts.has(owner.slice(owner.lastIndexOf(":") + 1));
}

/** Used only while BOTS_ACCEPT_LEGACY_OWNER_HEADER=1. Returns the owner DID, or null for a 401. */
export function authorizedOwner(req: Request, secret: string, accounts: Set<string> | "*"): string | null {
  if (!bearerMatches(req.headers.get("authorization"), secret)) return null;
  const owner = req.headers.get("x-tinycloud-owner") ?? "";
  return ownerAllowed(owner, accounts) ? owner : null;
}
