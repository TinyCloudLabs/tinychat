// TC-3195: the one file that calls the native-share SDK APIs (TC-3194). Every other module goes through
// these functions, so an SDK change (the subpath of the link reader, sign-in folding for reads) is one edit here.
//
// Secrets: a share token (`tc1:…`) and a link (`…#v=4&k=…`) are bearer secrets. They pass through these
// functions in memory only; nothing here logs, stores or reports them, and no error message carries them.
import { openNativeShareLink, publishNativeShareLink, type OpenedNativeShareLink } from "@tinycloud/share-sdk/native-link";
import { deserializeDelegation, serializeDelegation, type PortableDelegation, type TinyCloudWeb } from "@tinycloud/web-sdk";

import type { TinyCloudKv } from "@/lib/audio/audioStore";
import { firstNonEmpty } from "@/lib/buildEnv";
import { SHARE_LINK_ORIGIN } from "./link";

/** The links service that holds each link's sealed record. */
export const SHARE_LINKS_API_ORIGIN = firstNonEmpty(import.meta.env.VITE_SHARE_LINKS_API_ORIGIN) ?? "https://api.tinycloud.xyz";

const KV_GET = "tinycloud.kv/get";
const SHARE_KIND = "recording";

export type ShareLinkErrorCode = "gone" | "expired" | "invalid" | "unavailable";

/** A link that could not be opened. The message is fixed text: it never repeats the link. */
export class ShareLinkError extends Error {
  readonly code: ShareLinkErrorCode;
  constructor(code: ShareLinkErrorCode) {
    super(`share link: ${code}`);
    this.name = "ShareLinkError";
    this.code = code;
  }
}

/** Owner: the share made for one recording. `token` is a secret for `publishShareLink` only. */
export interface CreatedShare {
  token: string;
  rootCid: string;
  accessExpiresAt: string;
}

/** Owner, 1 wallet approval: a share of exactly `paths`, read-only, lasting until `accessExpiresAt`. */
export async function createShare(tcw: TinyCloudWeb, paths: readonly string[], accessExpiresAt: Date): Promise<CreatedShare> {
  const result = await tcw.sharing.generate({
    resources: paths.map((path) => ({ path, actions: [KV_GET] })),
    expiry: accessExpiresAt,
  });
  if (!result.ok) throw new Error(`share: ${result.error.code}`);
  return {
    token: result.data.token,
    rootCid: result.data.delegation.cid,
    accessExpiresAt: (result.data.expiresAt ?? accessExpiresAt).toISOString(),
  };
}

/** Owner: the short link. `link` is a secret: show and copy it while the sheet is open, never store it. */
export async function publishShareLink(input: { token: string; display: Record<string, unknown>; linkExpiresAt: Date }): Promise<{ link: string; id: string; expiresAt: string }> {
  const created = await publishNativeShareLink({
    token: input.token,
    kind: SHARE_KIND,
    display: input.display,
    linkOrigin: SHARE_LINK_ORIGIN,
    apiOrigin: SHARE_LINKS_API_ORIGIN,
    expiresAt: input.linkExpiresAt,
  });
  return { link: created.link, id: created.id, expiresAt: created.expiresAt };
}

/** Recipient: what an opened link carries. `token` stays in memory and goes only to `claimShare`. */
export interface OpenedShareLink {
  kind: string;
  display: unknown;
  token: string;
  linkExpiresAt: string;
  owner: { address: string; chainId: number; spaceId: string };
}

/** The link origins this app accepts: the share origin and the app's own https origin. */
function trustedOrigins(): string[] {
  const own = typeof window !== "undefined" && window.location.protocol === "https:" ? [window.location.origin] : [];
  return [...new Set([SHARE_LINK_ORIGIN, ...own])];
}

function errorField(error: unknown, field: "code" | "message"): unknown {
  return typeof error === "object" && error !== null && field in error ? Reflect.get(error, field) : undefined;
}

/** Recipient, signed in or not: read the link's record. Throws `ShareLinkError`. */
export async function openShareLink(href: string): Promise<OpenedShareLink> {
  let opened: OpenedNativeShareLink;
  try {
    opened = await openNativeShareLink(href, { trustedOrigins: trustedOrigins(), apiOrigin: SHARE_LINKS_API_ORIGIN });
  } catch (caught) {
    const code = errorField(caught, "code");
    throw new ShareLinkError(code === "gone" || code === "expired" || code === "invalid" ? code : "unavailable");
  }
  if (opened.kind !== SHARE_KIND) throw new ShareLinkError("invalid");
  return {
    kind: opened.kind,
    display: opened.display,
    token: opened.token,
    linkExpiresAt: opened.linkExpiresAt.toISOString(),
    owner: { address: opened.owner.address, chainId: opened.owner.chainId, spaceId: opened.owner.spaceId },
  };
}

/** Recipient: the claimed child delegation, safe to keep in the recipient's own space (only their key can use it). */
export interface ClaimedShare {
  /** The serialized child delegation. */
  delegation: string;
  rootCid: string;
  /** Every shared key or prefix, as full keys. */
  paths: string[];
  /** When access ends at the latest (the share's expiry), ISO. */
  accessExpiresAt: string;
}

export type ClaimResult = { ok: true; share: ClaimedShare } | { ok: false; reason: "revoked" | "expired" | "failed" };

/** Recipient, signed in, no approval: delegate the share to the account. */
export async function claimShare(tcw: TinyCloudWeb, token: string): Promise<ClaimResult> {
  if (!tcw.did) return { ok: false, reason: "failed" };
  const claim = await tcw.sharing.delegateReceivedShare(token, { delegateDID: tcw.did });
  if (!claim.ok) {
    if (claim.error.code === "REVOKED" || isShareRevokedError(claim.error)) return { ok: false, reason: "revoked" };
    if (claim.error.code === "AUTH_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "failed" };
  }
  const delegation = claim.data.delegation as unknown as PortableDelegation;
  return {
    ok: true,
    share: {
      delegation: serializeDelegation(delegation),
      rootCid: delegation.parentCid ?? claim.data.source.parentCid,
      paths: (delegation.resources ?? []).map((resource) => resource.path),
      accessExpiresAt: new Date(delegation.expiry).toISOString(),
    },
  };
}

/**
 * The key to ask a share's reader for. A share of several resources reads full keys; a share of ONE resource reads
 * relative to that resource's path: "" is the shared key itself, "manifest" is `<audio base>/manifest`.
 */
export function sharedKey(paths: readonly string[], fullKey: string): string {
  if (paths.length !== 1) return fullKey;
  const base = paths[0]!.replace(/\/$/, "");
  if (fullKey === base || fullKey === paths[0]) return "";
  return fullKey.startsWith(`${base}/`) ? fullKey.slice(base.length + 1) : fullKey;
}

/**
 * Recipient, 1 approval per session per share (until sign-in folding): a reader that always takes FULL keys, so
 * `getAudio(kv, audioBase)` and a transcript read work the same for one resource or several.
 */
export async function openSharedKv(tcw: TinyCloudWeb, delegation: string): Promise<TinyCloudKv> {
  const portable = deserializeDelegation(delegation);
  const access = await tcw.useDelegation(portable);
  const kv = access.kv as unknown as TinyCloudKv;
  const paths = (portable.resources ?? []).map((resource) => resource.path);
  if (paths.length !== 1) return kv;
  return new Proxy(kv, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "get") return value.bind(target);
      return (key: string, ...rest: unknown[]) => Reflect.apply(value, target, [sharedKey(paths, key), ...rest]);
    },
  });
}

/**
 * Owner: how many accounts have claimed the share (children of its root), or `null` when unknown. Listing needs
 * `tinycloud.delegation/list`, which the app's sign-in does not ask for: the node refuses it (PERMISSION_DENIED),
 * so this is `null` today and the sheet shows no "Opened by" line.
 */
export async function countShareClaims(tcw: TinyCloudWeb, rootCid: string): Promise<number | null> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await tcw.delegations.query({ direction: "all", status: "active", ...(cursor ? { cursor } : {}) });
    if (!page.ok) return null;
    count += page.data.items.filter((item) => item.cid !== rootCid && item.parents.includes(rootCid)).length;
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  return count;
}

/** Owner, 1 wallet approval: stop sharing. Everyone who opened it loses access; the link stops working. */
export async function revokeShare(tcw: TinyCloudWeb, rootCid: string): Promise<void> {
  const result = await tcw.revokeDelegation(rootCid);
  if (!result.ok) throw new Error(`stop sharing: ${result.error.code}`);
}

/** A read or activation refused because the owner stopped sharing. */
export function isShareRevokedError(error: unknown): boolean {
  const message = typeof error === "string" ? error : errorField(error, "message");
  return errorField(error, "code") === "REVOKED" || (typeof message === "string" && message.includes("ancestor_revoked"));
}
