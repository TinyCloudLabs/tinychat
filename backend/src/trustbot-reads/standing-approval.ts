import { createHash, randomBytes } from "node:crypto";
import { canonicalize, seal } from "@tinycloud/share-envelope";
import {
  APPROVAL_RESULT_CLIENT_ID, DEFAULT_LINKS_API_ORIGIN, LINK_ID_PATTERN, buildShortLink, linkIssuerPublicKey,
  prepareLinkRecord, parseApprovalRequest, type LinkRecord, type OpenKeyApprovalRequestV1,
} from "@tinycloud/share-envelope/links";
import type { StandingHolder } from "./standing-types.js";
import type { HolderScope, StandingApprovalKeys } from "./standing-holder.js";

const RESULT_REF = /^[A-Za-z0-9_-]{20,128}$/;
const APPROVAL_TYPE = "openkey-approval-request";
const TIMEOUT_MS = 5_000;
const RETENTION_MS = 600_000;

export interface StandingApprovalLink {
  requestId: string;
  bodyCid: string;
  expiresAt: string;
  record: Pick<LinkRecord, "header" | "signature">;
}

export type CollectedApproval =
  | { state: "pending" | "declined" | "expired" | "failed" }
  | { state: "ready"; resultRef: string; opened: Record<string, unknown> };

export type LeaseState = "active" | "stopped" | "expired" | "unavailable";

interface OpenKeyOrigins {
  links: string;
  api: string;
  web: string;
}
const OPENKEY_ORIGINS: OpenKeyOrigins = {
  links: DEFAULT_LINKS_API_ORIGIN,
  api: "https://api.openkey.so",
  web: "https://openkey.so",
};

export function standingTargetPublicJwk(holder: StandingHolder): OpenKeyApprovalRequestV1["targetPublicJwk"] {
  const key = linkIssuerPublicKey(holder.did);
  if (!key) throw new Error("invalid_standing_holder");
  return { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") };
}

export class StandingApprovalClient {
  constructor(private readonly deps: {
    keys: StandingApprovalKeys;
    origins?: OpenKeyOrigins;
    fetch?: typeof fetch;
    now?: () => number;
  }) {}

  async create(scope: HolderScope, holder: StandingHolder, request: OpenKeyApprovalRequestV1): Promise<StandingApprovalLink> {
    const origins = this.deps.origins ?? OPENKEY_ORIGINS;
    const now = this.deps.now?.() ?? Date.now();
    const plaintext = Buffer.from(canonicalize(parseApprovalRequest(request, { issuer: holder.did })));
    const { record, bodyCid } = await this.deps.keys.sealLink(scope, async key => {
      const { blob } = await seal(plaintext, key);
      return prepareLinkRecord({
        type: APPROVAL_TYPE, issuerKey: holder, apiOrigin: origins.links, now,
        expiresAt: new Date(now + 24 * 3600_000), sealed: { blob, key },
      });
    });
    const response = await this.#post(origins.links + "/v1/links", record);
    const created = await response.json();
    if (response.status !== 201 || typeof created?.id !== "string" || !LINK_ID_PATTERN.test(created.id) ||
        created.expiresAt !== record.header.expiresAt) throw new Error("standing_approval_create_failed");
    return { requestId: created.id, bodyCid, expiresAt: record.header.expiresAt, record: { header: record.header, signature: record.signature } };
  }

  url(scope: HolderScope, link: StandingApprovalLink): Promise<string> {
    return this.deps.keys.sealLink(scope, key => buildShortLink({
      origin: (this.deps.origins ?? OPENKEY_ORIGINS).web, type: APPROVAL_TYPE, id: link.requestId, key, bodyCid: link.bodyCid,
    }));
  }

  async collect(scope: HolderScope, holder: StandingHolder, link: StandingApprovalLink): Promise<CollectedApproval> {
    const now = this.deps.now?.() ?? Date.now();
    if (now >= Date.parse(link.expiresAt) + RETENTION_MS) return { state: "expired" };
    const found = await this.#call(holder, link, "discover");
    if (found.status === 202) return { state: "pending" };
    if (found.status === 404 || found.status === 410) {
      const body = await found.json().catch(() => null);
      return { state: body?.status === "denied" ? "declined" : "expired" };
    }
    if (found.status === 429 || found.status >= 500) return { state: "pending" };
    if (!found.ok) return { state: "failed" };
    const { resultRef, expiresAt } = await found.json();
    if (typeof resultRef !== "string" || !RESULT_REF.test(resultRef) || typeof expiresAt !== "string" ||
        !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) return { state: "failed" };
    const fetched = await this.#call(holder, link, "fetch", resultRef);
    if (fetched.status === 404 || fetched.status === 410) return { state: "expired" };
    if (fetched.status === 429 || fetched.status >= 500) return { state: "pending" };
    if (!fetched.ok) return { state: "failed" };
    const result = await fetched.json();
    if (result.requestId !== link.requestId || result.bodyCid !== link.bodyCid ||
        result.resultRef !== resultRef || result.expiresAt !== expiresAt) return { state: "failed" };
    try {
      return { state: "ready", resultRef, opened: await this.deps.keys.openResult(scope, link.requestId, result.relay) };
    } catch {
      return { state: "failed" };
    }
  }

  async acknowledge(holder: StandingHolder, link: StandingApprovalLink, resultRef: string, ackId: string): Promise<void> {
    await (await this.#call(holder, link, "ack", resultRef, ackId)).body?.cancel();
  }

  /**
   * OpenKey's lease status for this approval. `stopped` means the owner stopped renewal in OpenKey: OpenKey revokes
   * the lease at the node, which then ends the grant at its own signed end. It is not a revocation of the grant.
   * `none` with no grant means OpenKey holds no admitted lease for this approval.
   */
  async leaseState(holder: StandingHolder, link: StandingApprovalLink, originalCid: string, leaseEnd: number): Promise<LeaseState> {
    try {
      const response = await this.#call(holder, link, "lease-status", originalCid);
      if (!response.ok) {
        await response.body?.cancel();
        return "unavailable";
      }
      const result = await response.json();
      if (result.leaseState === "none" && result.originalCid === null) return "stopped";
      if (result.originalCid !== originalCid || Date.parse(result.leaseExpiresAt) !== leaseEnd * 1000) return "unavailable";
      if (result.leaseState === "stopped" || result.leaseState === "expired") return result.leaseState;
      if (result.leaseState !== "active") return "unavailable";
      return "active";
    } catch {
      return "unavailable";
    }
  }

  async #call(
    holder: StandingHolder,
    link: StandingApprovalLink,
    action: "discover" | "fetch" | "ack" | "lease-status",
    resultRef = "",
    ackId = "",
  ): Promise<Response> {
    const app = (this.deps.origins ?? OPENKEY_ORIGINS).api;
    const { requestId, bodyCid, record } = link;
    const requestPath = `/api/approval-requests/${requestId}`;
    const path = action === "discover" ? `${requestPath}/result` : action === "lease-status" ? `${requestPath}/lease-status` :
      `/api/approval-results/${resultRef}/${action}`;
    const body = action === "discover" ? { bodyCid, ...record } : action === "lease-status" ? { bodyCid, originalCid: resultRef || null } :
      { bodyCid, requestId, ...(action === "ack" ? { ackId } : {}) };
    const url = app + path;
    const { x } = standingTargetPublicJwk(holder);
    const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("base64url");
    const json = (input: unknown) => Buffer.from(JSON.stringify(input)).toString("base64url");
    const header = json({ alg: "EdDSA", kid: hash({ crv: "Ed25519", kty: "OKP", x }), typ: "openkey-session-proof+jwt" });
    const binding = [action, requestId, bodyCid, resultRef, ackId];
    const payload = json({
      client_id: APPROVAL_RESULT_CLIENT_ID, cred_hash: hash(binding), htm: "POST", htu: url,
      iat: Math.floor((this.deps.now?.() ?? Date.now()) / 1000), jti: randomBytes(24).toString("base64url"),
    });
    const signingInput = `${header}.${payload}`;
    const signature = Buffer.from(await holder.sign(Buffer.from(signingInput))).toString("base64url");
    return this.#post(url, body, `${signingInput}.${signature}`);
  }

  #post(url: string, body: unknown, proof?: string): Promise<Response> {
    return (this.deps.fetch ?? fetch)(url, {
      method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
      headers: { "content-type": "application/json", ...(proof ? { "OpenKey-Session-Proof": proof } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}
