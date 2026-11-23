// The owner's side of the server import: the two permissions our server is given, how they are signed from the
// authority the session already holds, and turning the import on, renewing it and turning it off.
// The permissions are exactly what the backend accepts (backend/src/fireflies-import-verify.ts); a test pins the two lists.
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { BOT_GRANT_MAX_LIFETIME_MS, botGrantLifetime } from "@/bots/botGrantLifetime";
import { serializePortableDelegation, toPortableDelegation } from "../agentDelegation";
import { collectImportGrantCids, revokeImportGrants, type DisconnectImportGrants } from "./connectorLifecycle";
import { encryptionNetworkId } from "./encryptionGrant";
import type { ConnectorWebhooksResult } from "./webhooksApi";

export const FIREFLIES_SECRET_KV_PATH = "vault/secrets/FIREFLIES_API_KEY";
export const FIREFLIES_SECRET_KEY_PATH = "secrets/fireflies_api_key";
export const FIREFLIES_MEETINGS_KV_PREFIX = "xyz.tinycloud.tinychat/connectors/fireflies/";

/** Words the approval screen shows for each permission. */
export const FIREFLIES_SECRETS_GRANT_DESCRIPTION = "Let our server open your Fireflies key to import meetings, for up to 7 days";
export const FIREFLIES_MEETINGS_GRANT_DESCRIPTION = "Let our server save meetings into your Fireflies folder, for up to 7 days";

/** Grant one: read the Fireflies key and open it. Nothing else in the secrets space. */
export function firefliesSecretsGrantEntries(address: string, chainId = 1): PermissionEntry[] {
  return [
    {
      service: "tinycloud.kv",
      space: "secrets",
      path: FIREFLIES_SECRET_KV_PATH,
      actions: ["get"],
      skipPrefix: true,
      description: FIREFLIES_SECRETS_GRANT_DESCRIPTION,
    },
    {
      service: "tinycloud.encryption",
      path: `${encryptionNetworkId(address, chainId)}/${FIREFLIES_SECRET_KEY_PATH}`,
      actions: ["decrypt"],
      skipPrefix: true,
      description: FIREFLIES_SECRETS_GRANT_DESCRIPTION,
    },
  ];
}

/** Grant two: save meetings into the Fireflies folder. Writing only; no read, no delete. */
export function firefliesMeetingsGrantEntries(): PermissionEntry[] {
  return [
    {
      service: "tinycloud.kv",
      space: "applications",
      path: FIREFLIES_MEETINGS_KV_PREFIX,
      actions: ["put"],
      skipPrefix: true,
      description: FIREFLIES_MEETINGS_GRANT_DESCRIPTION,
    },
  ];
}

/** Renewal is signed at 7 days less a minute, under the ceiling the server accepts (7 days plus a minute). */
const GRANT_LIFETIME_MS = BOT_GRANT_MAX_LIFETIME_MS - 60_000;
/** A grant with less than this left is replaced while the session can extend it. */
export const FIREFLIES_RENEW_WITHIN_MS = 6 * 86_400_000;
/** A grant with less than this left is shown as ending soon. */
export const FIREFLIES_ENDING_SOON_MS = 24 * 3_600_000;
const MIN_USEFUL_LIFETIME_MS = 60_000;

export type FirefliesImportState = "none" | "active" | "needs_renewal" | "revoked";

export interface FirefliesImportStatus {
  state: FirefliesImportState;
  expiresAt: string | null;
  delegateDid: string;
  grantCids: string[];
}

export interface FirefliesImportGrants {
  secretsGrant: string;
  meetingsGrant: string;
  siwe: string;
  signature: string;
}

export interface FirefliesImportApi {
  status(): Promise<ConnectorWebhooksResult<FirefliesImportStatus>>;
  /** `replaces` names the ids of the pair the server holds now, or none; the server refuses the pair when they differ. */
  submit(grants: FirefliesImportGrants, replaces: readonly string[]): Promise<ConnectorWebhooksResult<{ state: "active"; expiresAt: string }>>;
  removeGrant(): Promise<ConnectorWebhooksResult<null>>;
}

export type FirefliesSignError =
  | "signer_invalid"
  | "signed_out"
  | "session_missing"
  | "session_expired"
  | "authority_missing"
  | "unexpected_approval"
  | "session_changed";

export class FirefliesImportSignError extends Error {
  constructor(readonly code: FirefliesSignError) {
    super(`fireflies_import_${code}`);
  }
}

const DELEGATE_DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/** The lifetime a new pair gets: a week, and never past the session that signs it. */
export function firefliesGrantLifetime(siwe: string, now = Date.now()): number {
  return Math.min(GRANT_LIFETIME_MS, botGrantLifetime(siwe, now));
}

function cidOf(serialized: string): string | null {
  try {
    const cid = JSON.parse(serialized)?.cid;
    return typeof cid === "string" && cid ? cid : null;
  } catch {
    return null;
  }
}

/** The two ids inside a signed pair, so a refused pair can be withdrawn at the node. */
export function firefliesGrantCids(grants: Pick<FirefliesImportGrants, "secretsGrant" | "meetingsGrant">): string[] {
  return [cidOf(grants.secretsGrant), cidOf(grants.meetingsGrant)].filter((cid): cid is string => cid !== null);
}

/**
 * Signs both permissions to `delegateDid` from authority the session already holds. It never opens an approval
 * screen, cannot be passed on by the server (terminal grants), and refuses when the signed-in account changes
 * while it signs. Both are signed under the session's own sign-in message, which is what the server checks.
 */
export async function signFirefliesImportGrants(
  tcw: TinyCloudWeb,
  sessionStore: Pick<SessionStore, "getToken" | "getAddress">,
  delegateDid: string,
): Promise<FirefliesImportGrants> {
  if (!DELEGATE_DID_RE.test(delegateDid)) throw new FirefliesImportSignError("signer_invalid");
  const token = sessionStore.getToken();
  const address = sessionStore.getAddress()?.toLowerCase();
  if (!token || !address) throw new FirefliesImportSignError("signed_out");
  const session = tcw.session();
  if (!session?.siwe || !session.signature) throw new FirefliesImportSignError("session_missing");
  const lifetime = firefliesGrantLifetime(session.siwe);
  if (!Number.isFinite(lifetime) || lifetime < MIN_USEFUL_LIFETIME_MS) throw new FirefliesImportSignError("session_expired");

  const secretsEntries = firefliesSecretsGrantEntries(address);
  const meetingsEntries = firefliesMeetingsGrantEntries();
  // Check authority first: delegateTo would otherwise try to ask for the missing permission.
  if (!tcw.hasPermissions(secretsEntries) || !tcw.hasPermissions(meetingsEntries)) {
    throw new FirefliesImportSignError("authority_missing");
  }
  const host = tcw.hosts[0] ?? "https://tee.node.tinycloud.xyz";
  const sign = async (entries: PermissionEntry[]) => {
    const result = await tcw.delegateTo(delegateDid, entries, { expiry: lifetime, disableSubDelegation: true });
    if (result.prompted) throw new FirefliesImportSignError("unexpected_approval");
    return serializePortableDelegation(toPortableDelegation(result.delegation, address, 1, host));
  };
  const secretsGrant = await sign(secretsEntries);
  let meetingsGrant: string;
  try {
    meetingsGrant = await sign(meetingsEntries);
  } catch (error) {
    // The first is already signed at the node; do not leave it behind.
    await withdrawQuietly(tcw, [cidOf(secretsGrant)]);
    throw error;
  }
  const latest = sessionStore;
  if (latest.getToken() !== token || latest.getAddress()?.toLowerCase() !== address) {
    await withdrawQuietly(tcw, firefliesGrantCids({ secretsGrant, meetingsGrant }));
    throw new FirefliesImportSignError("session_changed");
  }
  return { secretsGrant, meetingsGrant, siwe: session.siwe, signature: session.signature };
}

async function withdrawQuietly(tcw: Pick<TinyCloudWeb, "revokeDelegation">, cids: ReadonlyArray<string | null>): Promise<void> {
  for (const cid of cids) {
    if (!cid) continue;
    try {
      await tcw.revokeDelegation(cid);
    } catch {
      // The permission ends on its own within 7 days.
    }
  }
}

export type TurnOnOutcome =
  | { kind: "on"; expiresAt: string; oldGrantsUnconfirmed: boolean }
  | { kind: "needs-sign-in" }
  | { kind: "unavailable" }
  | { kind: "failed" };

export interface FirefliesImportDeps {
  api: FirefliesImportApi;
  /** Signs a pair for a delegate; throws FirefliesImportSignError. */
  sign: (delegateDid: string) => Promise<FirefliesImportGrants>;
  /** Withdraws one permission at the node, as its owner; true when the node confirmed. */
  revoke: (cid: string) => Promise<boolean>;
}

/** Withdraws the permissions the new pair replaced, each with one more try; true when one could not be confirmed. */
async function withdrawReplaced(deps: Pick<FirefliesImportDeps, "revoke">, held: readonly string[], fresh: readonly string[]): Promise<boolean> {
  const stale = held.filter((cid) => !fresh.includes(cid));
  if (stale.length === 0) return false;
  return revokeImportGrants({ listGrantCids: async () => ({ status: "ok", value: stale }), revoke: deps.revoke }, stale);
}

/**
 * Signs a new pair, hands it to the server with the ids of the pair it replaces, then withdraws that pair. The server
 * refuses the pair when those ids are not what it holds, so a turn off or another renewal that got there first is
 * never undone. A refused pair is withdrawn again. A lost answer may follow a saved pair, so it is neither withdrawn
 * nor assumed: the server is asked what it holds, and the pair is withdrawn only when it does not hold it.
 */
export async function replaceFirefliesImportGrants(deps: FirefliesImportDeps, current: FirefliesImportStatus): Promise<TurnOnOutcome> {
  let grants: FirefliesImportGrants;
  try {
    grants = await deps.sign(current.delegateDid);
  } catch (error) {
    if (error instanceof FirefliesImportSignError && (error.code === "authority_missing" || error.code === "session_expired" || error.code === "signed_out" || error.code === "session_missing")) {
      return { kind: "needs-sign-in" };
    }
    return { kind: "failed" };
  }
  const submitted = await deps.api.submit(grants, current.grantCids);
  if (submitted.status === "ok") {
    return {
      kind: "on",
      expiresAt: submitted.value.expiresAt,
      oldGrantsUnconfirmed: await withdrawReplaced(deps, current.grantCids, firefliesGrantCids(grants)),
    };
  }
  if (submitted.status === "rejected" || submitted.status === "feature-dark") {
    for (const cid of firefliesGrantCids(grants)) await deps.revoke(cid).catch(() => false);
    return { kind: "failed" };
  }
  if (submitted.status === "unauthenticated") return { kind: "needs-sign-in" };
  // Offline or a server error: the pair may have been saved, so the server is asked what it holds.
  const after = await deps.api.status();
  if (after.status === "ok") {
    const fresh = firefliesGrantCids(grants);
    if (after.value.grantCids.some((cid) => fresh.includes(cid))) {
      if (after.value.state === "active" && after.value.expiresAt) {
        return { kind: "on", expiresAt: after.value.expiresAt, oldGrantsUnconfirmed: await withdrawReplaced(deps, current.grantCids, fresh) };
      }
    } else {
      // The server does not hold the new pair, so nothing records it: withdraw it rather than leave it live for a week.
      for (const cid of fresh) await deps.revoke(cid).catch(() => false);
    }
  }
  return { kind: "unavailable" };
}

/** Reads what the server holds, then signs and hands over a pair. */
export async function turnOnFirefliesImport(deps: FirefliesImportDeps): Promise<TurnOnOutcome> {
  const current = await deps.api.status();
  if (current.status === "unauthenticated") return { kind: "needs-sign-in" };
  if (current.status !== "ok") return { kind: current.status === "rejected" || current.status === "feature-dark" ? "failed" : "unavailable" };
  return replaceFirefliesImportGrants(deps, current.value);
}

export type TurnOffOutcome =
  | { kind: "off" }
  /** Off on our server, but a permission could not be confirmed withdrawn at the node. */
  | { kind: "off-unconfirmed" }
  /** Nothing was changed. */
  | { kind: "unavailable" };

/**
 * Turns the import off. The ids are read first (the server has none to list afterwards), then the server drops its
 * copy so no import starts, then each permission is withdrawn at the node, each with one more try.
 */
export async function turnOffFirefliesImport(api: Pick<FirefliesImportApi, "removeGrant">, grants: DisconnectImportGrants): Promise<TurnOffOutcome> {
  const collected = await collectImportGrantCids(grants, "disable-webhooks");
  if (collected.failure) return { kind: "unavailable" };
  const removed = await api.removeGrant();
  if (removed.status !== "ok" && removed.status !== "feature-dark") return { kind: "unavailable" };
  const unconfirmed = collected.grantCids.length > 0 && (await revokeImportGrants(grants, collected.grantCids));
  return unconfirmed ? { kind: "off-unconfirmed" } : { kind: "off" };
}

/** True when the session can sign a pair that ends later than the one the server holds. */
export function sessionCanExtend(siwe: string, savedExpiresAt: string | null, now = Date.now()): boolean {
  const lifetime = firefliesGrantLifetime(siwe, now);
  if (!Number.isFinite(lifetime) || lifetime < MIN_USEFUL_LIFETIME_MS) return false;
  if (savedExpiresAt === null) return true;
  const saved = Date.parse(savedExpiresAt);
  return !Number.isFinite(saved) || Math.floor((now + lifetime) / 1000) * 1000 > saved + 60_000;
}

/**
 * Whether the silent tick should replace the pair. Only on the browser where the owner turned the import on, and
 * never off a status that lists no ids: a pair names the ids it replaces, and a renewal has nothing safe to name
 * then. An active pair is replaced when under 6 days remain, a lapsed one at once. Either way only when the session
 * can extend it.
 */
export function firefliesImportDue(
  status: FirefliesImportStatus,
  options: { siwe: string; wanted: boolean; now?: number },
): boolean {
  const now = options.now ?? Date.now();
  if (!options.wanted || status.grantCids.length === 0) return false;
  if (!sessionCanExtend(options.siwe, status.expiresAt, now)) return false;
  if (status.state === "active") {
    const expires = status.expiresAt ? Date.parse(status.expiresAt) : Number.NaN;
    return Number.isFinite(expires) && expires - now < FIREFLIES_RENEW_WITHIN_MS;
  }
  return status.state === "needs_renewal";
}

export type FirefliesImportPhase = "off" | "on" | "ending-soon" | "paused";

/** What the row says for a state the server reported. */
export function firefliesImportPhase(status: FirefliesImportStatus, now = Date.now()): FirefliesImportPhase {
  if (status.state === "active" && status.expiresAt) {
    const expires = Date.parse(status.expiresAt);
    if (Number.isFinite(expires) && expires > now) return expires - now < FIREFLIES_ENDING_SOON_MS ? "ending-soon" : "on";
    return "paused";
  }
  if (status.state === "needs_renewal" || status.state === "revoked") return "paused";
  return "off";
}

const WANTED_KEY_PREFIX = "tinychat:fireflies-import-wanted:";
type WantedStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultWantedStore(): WantedStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether this owner turned the server import on from this browser, so a lapsed pair is worth replacing silently. */
export function readFirefliesImportWanted(address: string, store: WantedStore | null = defaultWantedStore()): boolean {
  try {
    return store?.getItem(`${WANTED_KEY_PREFIX}${address.toLowerCase()}`) === "1";
  } catch {
    return false;
  }
}

export function writeFirefliesImportWanted(address: string, wanted: boolean, store: WantedStore | null = defaultWantedStore()): void {
  try {
    if (wanted) store?.setItem(`${WANTED_KEY_PREFIX}${address.toLowerCase()}`, "1");
    else store?.removeItem(`${WANTED_KEY_PREFIX}${address.toLowerCase()}`);
  } catch {
    // A blocked store only means a lapsed pair is not replaced on its own.
  }
}

let renewing = false;

/**
 * The silent tick: replaces the pair when it is due and the session can extend it. Never asks for anything; a pair
 * that cannot be signed is left as it is. One run at a time. True when a new pair was handed over.
 */
export async function renewFirefliesImportIfDue(deps: FirefliesImportDeps, context: { siwe: string; wanted: boolean; now?: number }): Promise<boolean> {
  if (renewing) return false;
  renewing = true;
  try {
    const current = await deps.api.status();
    if (current.status !== "ok") return false;
    if (!firefliesImportDue(current.value, { siwe: context.siwe, wanted: context.wanted, now: context.now })) return false;
    return (await replaceFirefliesImportGrants(deps, current.value)).kind === "on";
  } catch {
    return false;
  } finally {
    renewing = false;
  }
}
