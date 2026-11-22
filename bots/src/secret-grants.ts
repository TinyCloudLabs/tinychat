// Secret requests, gateway side. For each request the supervisor sends (PUT /bots/<botId>/secrets/<id>), the gateway:
//  1. makes a fresh Ed25519 key that will hold the grant, and a P-256 key OpenKey encrypts the result to;
//  2. signs a one-tap OpenKey approval request: read ONE secret (kv get vault/secrets/NAME in the owner's "secrets"
//     space) and decrypt with the owner's default network, for at most MAX_GRANT_SECONDS, suggesting an hour;
//  3. polls OpenKey for the result itself, checks it (below), seals it with the key and keeps it on its own volume;
//  4. reports approved / declined / expired / failed to the supervisor when it drains (POST .../secrets/drain);
//  5. reads the value only to make a call_with_secret call (secret-call.ts), and never returns it.
// DELETE .../secrets/<id> (Stop now, decline, expiry, the end of access, a retry) unlinks the sealed file and drops
// the in-memory copy and the node session. JS can't zero memory, so that is all it promises.
//
// Before a result is kept (Bobbie's review, 22 Nov): it must answer exactly this request (share-envelope's binding
// check), the SIWE must be signed by the owner the supervisor named, every resource it grants must be the owner's,
// its audience must be this request's key, and it must end no later than the lifetime asked for.

import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { ApprovalRequesterState, CheckedApprovalResult, CreatedLink, Ed25519PrivateJwk, LinkRecord, LinkSigner, OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import * as approvalLinks from "@tinycloud/share-envelope/links";
import { getAddress, verifyMessage } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { MAX_WHY_CHARS, type SecretPush } from "./asks";
import type { GuardDeps } from "./fetch-guard";
import { isRecord } from "./guards";
import { OWNER_DID } from "./owner";
import { type ApprovedSecret, DAILY_CALLS_PER_SECRET, DAILY_REPLY_BYTES_PER_SECRET, prepareCall, refusal, secretName, sendCall } from "./secret-call";
import { knownSecret, SECRET_NAME, secretSites } from "./secret-catalog";
import type { GrantStore } from "./secret-store";
import { REQUEST_ID } from "./secret-store";
import { toolText } from "./web";

/**
 * Longest grant the gateway asks for. One delegation can read the secret for this long, and today the decrypt half
 * covers the owner's whole default network, so it is kept short until TC-3284 (per-secret keys) lands (Naomi's
 * ruling, 22 Nov). The owner can pick less; never more.
 */
export const MAX_GRANT_SECONDS = 7 * 24 * 3600;
/** What the approval screen offers first. */
export const SUGGESTED_GRANT_SECONDS = 3600;
/** How long the owner has to open the link. */
export const LINK_MS = 24 * 3600 * 1000;
/** OpenKey keeps an approved result this long (APPROVAL_RESULT_RETENTION_SECONDS=600 in its production compose). */
const RESULT_RETENTION_MS = 600_000;
const SKEW_MS = 60_000;
const HEADER = /^[a-z0-9-]{1,64}$/;

export type GrantState = "pending" | "approved" | "declined" | "expired" | "failed" | "ended";
export type Outcome = { id: string; outcome: "approved"; until: number } | { id: string; outcome: "declined" | "expired" | "failed" };

/** What the supervisor asks for: name and sites as the owner approves them, the header the value goes in, `why` from Main. */
export interface SecretAsk {
  name: string;
  sites: string[];
  header: string;
  why: string;
  ownerDid: string;
}

/** OpenKey's delegation, as `restoreSession` takes it. */
export interface GrantSession {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  jwk: Ed25519PrivateJwk;
  verificationMethod: string;
  address: string;
  chainId: number;
  siwe: string;
  signature: string;
  expiresAt: string;
}

/** One request's sealed record. Key material is dropped as soon as the request can no longer be used. */
interface GrantRecord {
  botId: string;
  ask: SecretAsk;
  state: GrantState;
  /** The outcome was given to the supervisor. */
  reported: boolean;
  approveUrl: string;
  linkExpiresAt: number;
  until?: number;
  calls: { day: string; count: number; bytes: number };
  keys?: {
    jwk: Ed25519PrivateJwk;
    relayPrivateKey: string;
    request: OpenKeyApprovalRequestV1;
    requestId: string;
    bodyCid: string;
    record: ApprovalRequesterState["record"];
    ackId: string;
    session?: GrantSession;
  };
}

export type ReadValue = { value: string } | "missing" | "unavailable";

/** Reads one secret with an approved delegation (secret-node.ts). `forget` drops anything cached for a request. */
export interface SecretReader {
  read(id: string, session: GrantSession, name: string): Promise<ReadValue>;
  forget(id: string): void;
}

export type ApprovalLinks = Pick<
  typeof approvalLinks,
  "createApprovalRequest" | "discoverApprovalResult" | "fetchApprovalResult" | "openRelayResult" | "checkApprovalResultBinding" | "ackApprovalResult" | "generateRelayKey" | "signerFromJwk" | "isApprovalClientError"
>;

export interface ApprovalOrigins {
  /** TinyCloud node the grant is for. */
  node: string;
  /** Links API that stores the request. */
  linksApi: string;
  /** Where the owner opens the link. */
  openkey: string;
  /** OpenKey API the result is collected from. */
  openkeyApi: string;
}

export interface SecretGrantDeps {
  store: GrantStore;
  reader: SecretReader;
  origins: ApprovalOrigins;
  links?: ApprovalLinks;
  now?: () => number;
  /**
   * Who signs the approval request. share-envelope 1.6.0 requires the signer to be the grant's own key, so today it
   * is; TC-3772 lets a stable TinyCloud One key sign instead, and only this changes (Naomi's ruling, 22 Nov).
   */
  requester?: (target: LinkSigner) => LinkSigner;
}

export type AskResult = { approveUrl: string; expiresAt: string } | { refused: "invalid" | "conflict" | "unavailable" };

/** A call_with_secret answer for Main, and the one-word outcome the gateway logs (never the value or the call). */
export interface SecretCallOutcome {
  result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  outcome: string;
}

/** The permissions a request asks for: one secret, and decryption with the owner's default network. */
export function secretPermissions(name: string, ownerDid: string): OpenKeyApprovalRequestV1["permissions"] {
  // OpenKey and the node name the network with the checksummed address, as Secret Manager does.
  const owner = `did:pkh:eip155:1:${getAddress(ownerDid.slice(ownerDid.lastIndexOf(":") + 1))}`;
  return [
    { service: "tinycloud.kv", space: "secrets", path: `vault/secrets/${name}`, actions: ["tinycloud.kv/get"] },
    { service: "tinycloud.encryption", space: "encryption", path: `urn:tinycloud:encryption:${owner}:default`, actions: ["tinycloud.encryption/decrypt"] },
  ];
}

/**
 * The supervisor's request body, checked. A known service's sites and header must be the catalog's own: the
 * supervisor sends them from the same table, and a mismatch means something sent what it shouldn't.
 */
export function parseAsk(input: unknown): SecretAsk | undefined {
  if (!isRecord(input)) return undefined;
  const { name, header, why, ownerDid } = input;
  if (typeof name !== "string" || !SECRET_NAME.test(name)) return undefined;
  const sites = secretSites(input.sites);
  if (!sites || typeof header !== "string" || !HEADER.test(header)) return undefined;
  const known = knownSecret(name);
  if (known && (header !== known.header.name || sites.length !== 1 || sites[0] !== known.site)) return undefined;
  if (typeof why !== "string" || why.length > MAX_WHY_CHARS) return undefined;
  if (typeof ownerDid !== "string" || !OWNER_DID.test(ownerDid)) return undefined;
  return { name, sites, header, why, ownerDid };
}

/**
 * Checks an opened, bound result against the owner the supervisor named and the key this request made. Returns the
 * session to keep, or throws a message naming the check that failed (never a value).
 */
export async function verifiedGrant(checked: CheckedApprovalResult, expected: { ownerDid: string; targetDid: string; jwk: Ed25519PrivateJwk; maxSeconds: number; now: number }): Promise<GrantSession> {
  const d = checked.delegation;
  const header = isRecord(d.delegationHeader) ? d.delegationHeader.Authorization : undefined;
  const fields = [d.siwe, d.signature, d.delegationCid, d.spaceId, d.address, d.verificationMethod, header];
  if (!fields.every(field => typeof field === "string" && field !== "") || d.chainId !== 1) throw new Error("the delegation is incomplete");
  const address = (d.address as string).toLowerCase();
  const owner = expected.ownerDid.toLowerCase();
  if (`did:pkh:eip155:1:${address}` !== owner || checked.ownerDid.toLowerCase() !== owner) throw new Error("the result names another owner");

  const siwe = parseSiweMessage(d.siwe as string);
  if (siwe.address?.toLowerCase() !== address || siwe.chainId !== 1) throw new Error("the signed message names another account");
  if (!(await verifyMessage({ address: getAddress(address), message: d.siwe as string, signature: d.signature as `0x${string}` }).catch(() => false))) {
    throw new Error("the signed message is not the owner's signature");
  }
  // Its audience is this request's key and nobody else.
  if (siwe.uri?.split("#")[0] !== expected.targetDid || (d.verificationMethod as string).split("#")[0] !== expected.targetDid) {
    throw new Error("the grant is for another key");
  }
  const issued = siwe.issuedAt?.getTime();
  const expires = siwe.expirationTime?.getTime();
  if (issued === undefined || expires === undefined || new Date(expires).toISOString() !== checked.delegationExpiresAt) throw new Error("the grant's expiry doesn't match");
  if (expires - issued > expected.maxSeconds * 1000 + SKEW_MS || expires <= expected.now) throw new Error("the grant is longer than asked or already over");

  // Every resource it grants, and the space it opens, must be the owner's own.
  const space = `tinycloud:pkh:eip155:1:${address}:`;
  const network = `urn:tinycloud:encryption:${owner}:`;
  const owned = (resource: string) => resource.toLowerCase().startsWith(space) || resource.toLowerCase().startsWith(network);
  if (!(d.spaceId as string).toLowerCase().startsWith(space)) throw new Error("the grant opens another owner's space");
  const resources = siwe.resources ?? [];
  if (resources.length === 0) throw new Error("the grant names no resource");
  for (const resource of resources) {
    if (!resource.startsWith("urn:recap:")) {
      if (!owned(resource)) throw new Error("the grant names another owner's resource");
      continue;
    }
    let recap: unknown;
    try {
      recap = JSON.parse(Buffer.from(resource.slice("urn:recap:".length), "base64url").toString("utf8"));
    } catch {
      throw new Error("the grant's capabilities don't parse");
    }
    if (!isRecord(recap) || !isRecord(recap.att) || !Object.keys(recap.att).every(owned)) throw new Error("the grant names another owner's resource");
  }
  return {
    delegationHeader: { Authorization: header as string },
    delegationCid: d.delegationCid as string,
    spaceId: d.spaceId as string,
    jwk: expected.jwk,
    verificationMethod: d.verificationMethod as string,
    address: d.address as string,
    chainId: 1,
    siwe: d.siwe as string,
    signature: d.signature as string,
    expiresAt: checked.delegationExpiresAt,
  };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class SecretGrants {
  readonly #records = new Map<string, GrantRecord>();
  readonly #store: GrantStore;
  readonly #reader: SecretReader;
  readonly #origins: ApprovalOrigins;
  readonly #links: ApprovalLinks;
  readonly #now: () => number;
  readonly #requester: (target: LinkSigner) => LinkSigner;
  /** Bots with a call_with_secret call running: one at a time each. */
  readonly #calling = new Set<string>();
  #polling = false;

  constructor(deps: SecretGrantDeps) {
    this.#store = deps.store;
    this.#reader = deps.reader;
    this.#origins = deps.origins;
    this.#links = deps.links ?? approvalLinks;
    this.#now = deps.now ?? Date.now;
    this.#requester = deps.requester ?? (target => target);
    for (const entry of this.#store.load()) {
      const record = entry.record as GrantRecord | undefined;
      // A record that no longer opens (the app id, and so the key, changed) can't be used: it ends as failed.
      if (!isRecord(record) || record.botId !== entry.botId) {
        this.#records.set(entry.id, { botId: entry.botId, ask: { name: "", sites: [], header: "", why: "", ownerDid: "" }, state: "failed", reported: false, approveUrl: "", linkExpiresAt: 0, calls: { day: "", count: 0, bytes: 0 } });
        continue;
      }
      this.#records.set(entry.id, record);
    }
  }

  /** Opens a request, or returns the same link while the same request is still open. */
  async ask(botId: string, id: string, ask: SecretAsk): Promise<AskResult> {
    if (!REQUEST_ID.test(id)) return { refused: "invalid" };
    const now = this.#now();
    const open = this.#records.get(id);
    if (open) {
      if (open.botId === botId && open.state === "pending" && open.linkExpiresAt > now && open.ask.name === ask.name) {
        return { approveUrl: open.approveUrl, expiresAt: new Date(open.linkExpiresAt).toISOString() };
      }
      return { refused: "conflict" };
    }
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Ed25519PrivateJwk;
    const target = this.#links.signerFromJwk(jwk);
    const requester = this.#requester(target);
    const relay = this.#links.generateRelayKey();
    const service = knownSecret(ask.name)?.service;
    const where = service ? `${service} (${ask.sites.join(", ")})` : ask.sites.join(", ");
    const request: OpenKeyApprovalRequestV1 = {
      issuer: requester.did,
      requestVersion: 1,
      targetDid: target.did,
      targetPublicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      nodeOrigin: this.#origins.node,
      permissions: secretPermissions(ask.name, ask.ownerDid),
      reason: `Use ${ask.name} with ${where}. ${ask.why}`.trim(),
      grantLifetimeSeconds: MAX_GRANT_SECONDS,
      suggestedLifetimeSeconds: SUGGESTED_GRANT_SECONDS,
      resultEncryptionPublicJwk: relay.publicJwk,
    };
    let created: CreatedLink & { record: LinkRecord };
    try {
      created = await this.#links.createApprovalRequest({
        request, issuerKey: requester, apiOrigin: this.#origins.linksApi, openkeyOrigin: this.#origins.openkey, expiresAt: new Date(now + LINK_MS), now,
      });
    } catch {
      return { refused: "unavailable" };
    }
    // A link this gateway made: it may answer it only after a concurrent ask for the same id lost the race.
    if (this.#records.has(id)) return { refused: "conflict" };
    const linkExpiresAt = Date.parse(created.expiresAt);
    const record: GrantRecord = {
      botId, ask, state: "pending", reported: false, approveUrl: created.link, linkExpiresAt, calls: { day: "", count: 0, bytes: 0 },
      keys: { jwk, relayPrivateKey: relay.privateKey, request, requestId: created.id, bodyCid: created.bodyCid, record: { header: created.record.header, signature: created.record.signature }, ackId: randomUUID() },
    };
    try {
      this.#store.save(id, botId, record);
    } catch {
      return { refused: "unavailable" };
    }
    this.#records.set(id, record);
    return { approveUrl: created.link, expiresAt: new Date(linkExpiresAt).toISOString() };
  }

  /** One pass over open requests: collects approvals, notices declines and expiries, ends access that ran out. */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      for (const [id, record] of [...this.#records]) {
        if (record.state === "pending") await this.#collect(id, record);
        else if (record.state === "approved" && (record.until ?? 0) <= this.#now()) this.#settle(id, record, "ended");
      }
    } finally {
      this.#polling = false;
    }
  }

  /** Outcomes not yet given to the supervisor for this bot. Each is given once. */
  drain(botId: string): Outcome[] {
    const outcomes: Outcome[] = [];
    for (const [id, record] of this.#records) {
      if (record.botId !== botId || record.reported) continue;
      if (record.state === "approved") outcomes.push({ id, outcome: "approved", until: record.until! });
      else if (record.state === "declined" || record.state === "expired" || record.state === "failed") outcomes.push({ id, outcome: record.state });
      else continue;
      record.reported = true;
      this.#save(id, record);
    }
    return outcomes;
  }

  /** Stop now, decline, expiry, the end of access, a retry: the key and the delegation go, on disk and in memory. */
  remove(botId: string, id: string): boolean {
    const record = this.#records.get(id);
    if (!record || record.botId !== botId) return false;
    this.#store.remove(id);
    this.#records.delete(id);
    this.#reader.forget(id);
    return true;
  }

  /**
   * One call_with_secret call. `pushed` is the supervisor's list for the bot, which knows of requests the gateway
   * hasn't been sent yet. Returns the tool result and a one-word outcome to log; neither ever holds the value, the
   * call's address, headers or body.
   */
  async call(botId: string, args: Record<string, unknown>, net: GuardDeps, pushed: readonly SecretPush[] = []): Promise<SecretCallOutcome> {
    const name = secretName(args);
    if (!name) return { result: refusal("invalid"), outcome: "invalid" };
    const found = this.#forName(botId, name);
    const now = this.#now();
    if (!found) {
      const listed = pushed.find(secret => secret.name === name);
      if (listed?.state === "pending") return { result: refusal("pending", { name }), outcome: "pending" };
      if (listed?.state === "ended" && listed.until !== undefined) return { result: refusal("ended", { name, until: listed.until }), outcome: "ended" };
      return { result: refusal("notAsked", { name }), outcome: "not_asked" };
    }
    const [id, record] = found;
    // The supervisor's word is final once it has one: Stop now holds even before its DELETE reaches this gateway.
    const told = pushed.find(secret => secret.id === id)?.state;
    if (told === "ended") return { result: refusal("ended", { name, until: record.until }), outcome: "ended" };
    if (told !== undefined && told !== "pending" && told !== "approved") return { result: refusal("notAsked", { name }), outcome: "not_asked" };
    if (record.state === "pending") return { result: refusal("pending", { name }), outcome: "pending" };
    if (record.state === "ended" || (record.state === "approved" && (record.until ?? 0) <= now)) {
      return { result: refusal("ended", { name, until: record.until }), outcome: "ended" };
    }
    if (record.state !== "approved" || !record.keys?.session) return { result: refusal("notAsked", { name }), outcome: "not_asked" };
    const secret: ApprovedSecret = { name, sites: record.ask.sites, header: record.ask.header, until: record.until! };
    const prepared = prepareCall(args, secret);
    if ("refused" in prepared) {
      return { result: refusal(prepared.refused, { name, sites: secret.sites, header: secret.header }), outcome: `refused_${prepared.refused}` };
    }
    const day = utcDay(now);
    const today = record.calls.day === day ? record.calls : { day, count: 0, bytes: 0 };
    if (today.count >= DAILY_CALLS_PER_SECRET || today.bytes >= DAILY_REPLY_BYTES_PER_SECRET) return { result: refusal("daily", { name }), outcome: "daily" };
    if (this.#calling.has(botId)) return { result: refusal("busy"), outcome: "busy" };
    this.#calling.add(botId);
    try {
      const read = await this.#reader.read(id, record.keys.session, name);
      if (read === "missing") return { result: refusal("missing", { name }), outcome: "missing" };
      if (read === "unavailable") return { result: refusal("unavailable", { name }), outcome: "unavailable" };
      // Counted before the call: a call that fails or times out was still made with the value.
      record.calls = { ...today, count: today.count + 1 };
      if (!this.#save(id, record)) return { result: refusal("unavailable", { name }), outcome: "store" };
      const sent = await sendCall(prepared, read.value, net);
      if (sent.bytes > 0) {
        record.calls = { ...record.calls, bytes: record.calls.bytes + sent.bytes };
        this.#save(id, record); // a lost byte count only lets a day's cap run a little late
      }
      const host = prepared.url.hostname;
      if (sent.ok) return { result: toolText(sent.text), outcome: "ok" };
      if (sent.reason === "value") return { result: refusal("unavailable", { name }), outcome: "bad_value" };
      if (sent.reason === "redirect") return { result: refusal("redirect", { host, address: sent.address }), outcome: "redirect" };
      return { result: refusal("failed", { host, reason: sent.reason }), outcome: "call_failed" };
    } finally {
      this.#calling.delete(botId);
    }
  }

  /** The request that answers for this name: one that is approved first, then one waiting, then the latest other. */
  #forName(botId: string, name: string): [string, GrantRecord] | undefined {
    const rank: Record<GrantState, number> = { approved: 5, pending: 4, ended: 3, expired: 2, declined: 2, failed: 1 };
    let best: [string, GrantRecord] | undefined;
    for (const entry of this.#records) {
      const record = entry[1];
      if (record.botId !== botId || record.ask.name !== name) continue;
      if (!best || rank[record.state] > rank[best[1].state] || (rank[record.state] === rank[best[1].state] && (record.until ?? 0) > (best[1].until ?? 0))) best = entry;
    }
    return best;
  }

  #save(id: string, record: GrantRecord): boolean {
    try {
      this.#store.save(id, record.botId, record);
      return true;
    } catch {
      return false;
    }
  }

  /** A request that can no longer be used keeps its name, sites and end for answers; its keys go now. */
  #settle(id: string, record: GrantRecord, state: Exclude<GrantState, "pending" | "approved">): void {
    record.state = state;
    record.keys = undefined;
    this.#reader.forget(id);
    this.#save(id, record);
  }

  async #collect(id: string, record: GrantRecord): Promise<void> {
    const keys = record.keys;
    const now = this.#now();
    if (!keys) return this.#settle(id, record, "failed");
    // Past the link's end and OpenKey's retention, no approval can exist any more.
    if (now >= record.linkExpiresAt + RESULT_RETENTION_MS + SKEW_MS) return this.#settle(id, record, "expired");
    const state: ApprovalRequesterState = { requestId: keys.requestId, bodyCid: keys.bodyCid, record: keys.record, apiOrigin: this.#origins.openkeyApi, signingKey: keys.jwk };
    let resultRef: string;
    let session: GrantSession;
    try {
      const found = await this.#links.discoverApprovalResult(state);
      if (found.status === "pending") return;
      resultRef = found.resultRef;
      const envelope = await this.#links.fetchApprovalResult(state, found);
      const opened = await this.#links.openRelayResult(envelope, keys.requestId, keys.relayPrivateKey);
      const checked = this.#links.checkApprovalResultBinding(opened, { requestId: keys.requestId, bodyCid: keys.bodyCid, request: keys.request, now });
      session = await verifiedGrant(checked, { ownerDid: record.ask.ownerDid, targetDid: keys.request.targetDid, jwk: keys.jwk, maxSeconds: keys.request.grantLifetimeSeconds, now });
    } catch (error) {
      if (this.#links.isApprovalClientError(error)) {
        if (error.code === "network" || error.code === "unavailable") return; // asked again next pass
        // OpenKey answers a denied request as an expired one (410); before the link's own end, it was a decline.
        if (error.code === "request_expired") return this.#settle(id, record, now < record.linkExpiresAt - SKEW_MS ? "declined" : "expired");
        if (error.code === "not_found") return this.#settle(id, record, "expired");
      }
      console.log(JSON.stringify({ gateway: "secret", bot: record.botId.slice(0, 12), outcome: "result_refused", code: this.#links.isApprovalClientError(error) ? error.code : "check" }));
      return this.#settle(id, record, "failed");
    }
    record.state = "approved";
    record.until = Date.parse(session.expiresAt);
    keys.session = session;
    if (!this.#save(id, record)) {
      // Not kept, so not acknowledged: OpenKey still holds the result and the next pass collects it again.
      record.state = "pending";
      record.until = undefined;
      keys.session = undefined;
      return;
    }
    await this.#links.ackApprovalResult(state, resultRef, keys.ackId).catch(() => undefined); // OpenKey drops it in 10 minutes anyway
  }
}
