import { createHash, timingSafeEqual } from "node:crypto";

/** The only owner form the backend sends: did:pkh on chain 1 with the lowercased address. */
export const OWNER_DID = /^did:pkh:eip155:1:0x[0-9a-f]{40}$/;
export const BOT_ID = /^[0-9a-f]{64}$/;

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

/** A bot's stable id: sha256 of the owner DID. Paths are built from this, never from the DID. */
export function botIdFor(ownerDid: string): string {
  return digest(ownerDid).toString("hex");
}

/**
 * Service authentication for every API request except /healthz: the shared secret, a well-formed owner DID,
 * and an owner on the service's own account allowlist. Returns the owner DID, or null for a 401.
 */
export function authorizedOwner(req: Request, secret: string, accounts: Set<string> | "*"): string | null {
  if (!bearerMatches(req.headers.get("authorization"), secret)) return null;
  const owner = req.headers.get("x-tinycloud-owner") ?? "";
  if (!OWNER_DID.test(owner)) return null;
  const address = owner.slice(owner.lastIndexOf(":") + 1);
  if (accounts !== "*" && !accounts.has(address)) return null;
  return owner;
}
