// TrustBot's read grants: one delegation per owner, signed in the owner's browser to TrustBot's own read identity,
// read-only, for at most 7 days. The grant names the resources of every area the owner turned on (areas.ts). It is
// stored sealed in the backend's own space and checked again, then activated, on every read.
// Details: TC-3792
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { DelegatedAccess, TinyCloudNode } from "@tinycloud/node-sdk";
import { verifyTranscriptWriterGrant, type VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation, DelegationActivationError } from "../portable-delegation.js";
import type { StandingReadPolicyRefusal, StandingReadRuntime } from "./standing.js";
import { areaResources, isReadArea, READ_AREA_NAMES, READ_AREAS, type ReadArea, type ReadResource } from "./areas.js";

/** Where each owner's grant is kept, in the backend's own space. */
export const TRUSTBOT_READ_GRANT_KEY_PREFIX = "trustbot/read-grants/";
/** The longest a read grant may last. */
export const READ_GRANT_MAX_MS = 7 * 86_400_000;
/** Clock slack between the owner's browser and the backend. */
const CLOCK_SLACK_MS = 5 * 60_000;
/** How long one activation is reused before the node is asked again. The grant itself is checked on every read. */
const ACTIVATION_REUSE_MS = 5 * 60_000;

export type ReadAccess = DelegatedAccess;
export type AreaState = "off" | "on" | "ended";
/**
 * `grantCid` names the stored grant so the owner's browser can revoke it at the node: the node accepts a revocation
 * only from the owner who delegated, never from TrustBot's read identity that received it.
 */
export interface ReadStatus { expiresAt: number | null; grantCid: string | null; areas: Record<ReadArea, AreaState> }
export interface GrantEnvelope { serialized: string; siwe: string; signature: string }

/** `none`: nothing stored. `off`: the owner has not turned this area on. `ended`: the grant expired. */
export type ReadRefusal = "none" | "off" | "ended" | "rejected" | "unavailable";
export class ReadGrantRefused extends Error {
  constructor(readonly code: ReadRefusal, readonly auditOutcome?: StandingReadPolicyRefusal) { super(`trustbot_read_${code}`); this.name = "ReadGrantRefused"; }
}
/** The grant the owner sent does not match what turning the area on needs. */
export class ReadGrantInvalid extends Error {
  constructor(readonly code: string) { super(`trustbot_read_grant_${code}`); this.name = "ReadGrantInvalid"; }
}

interface StoredReads extends GrantEnvelope { v: 1; areas: ReadArea[]; cid: string; expiresAt: number }

/** The backend's own key-value store, holding the sealed record. */
export interface ReadGrantStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TrustBotReadGrantsOptions {
  /** Signed in as TrustBot's read identity, and used for nothing else. */
  reader: Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid">;
  store: ReadGrantStore;
  /** The configured TinyCloud node. */
  host: string;
  /** Secret the storage key is derived from. */
  sealSecret: Uint8Array;
  now?: () => number;
  standing?: StandingReadRuntime;
  /** Checks a grant; the default is the signed verifier in delegation-verify.ts. */
  verify?: typeof verifyTranscriptWriterGrant;
  /** Activates a checked grant at the node; the default is activateVerifiedDelegation. */
  activate?: (verified: VerifiedTranscriptWriter) => Promise<ReadAccess>;
}

function checkAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ReadGrantRefused("none");
  return address.toLowerCase();
}

function isStored(value: unknown): value is StoredReads {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && Array.isArray(v.areas) && v.areas.length > 0 && v.areas.every(isReadArea)
    && typeof v.cid === "string" && typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt)
    && typeof v.serialized === "string" && typeof v.siwe === "string" && typeof v.signature === "string";
}

/**
 * The activations an area needs: one for the whole area, or one per resource when it names more than one SQL
 * database, since one activation takes at most one.
 */
function activationPaths(area: ReadArea): (string | undefined)[] {
  const resources = READ_AREAS[area] as readonly ReadResource[];
  return resources.filter(entry => entry.service === "sql").length <= 1 ? [undefined] : resources.map(entry => entry.path);
}

export class TrustBotReadGrants {
  readonly #reader: TrustBotReadGrantsOptions["reader"];
  readonly #store: ReadGrantStore;
  readonly #host: string;
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #standing?: StandingReadRuntime;
  readonly #verify: typeof verifyTranscriptWriterGrant;
  readonly #activate: (verified: VerifiedTranscriptWriter) => Promise<ReadAccess>;
  readonly #activations = new Map<string, { access: ReadAccess; until: number }>();

  constructor(options: TrustBotReadGrantsOptions) {
    this.#reader = options.reader;
    this.#store = options.store;
    this.#host = options.host;
    this.#key = Buffer.from(hkdfSync("sha256", options.sealSecret, Buffer.alloc(0), "tinychat.trustbot-reads.grants/v1", 32));
    this.#now = options.now ?? Date.now;
    this.#standing = options.standing;
    this.#verify = options.verify ?? verifyTranscriptWriterGrant;
    this.#activate = options.activate ?? (verified => activateVerifiedDelegation(this.#reader as TinyCloudNode, verified, { host: this.#host }));
  }

  /** The DID the owner delegates to. */
  get serviceDid(): string {
    return this.#reader.did;
  }

  /** Each area's state for this owner, and when the grant ends. */
  async status(address: string): Promise<ReadStatus> {
    const stored = await this.#load(checkAddress(address));
    const ended = stored !== undefined && stored.expiresAt <= this.#now();
    const areas = Object.fromEntries(READ_AREA_NAMES.map(area => [
      area, !stored?.areas.includes(area) ? "off" : ended ? "ended" : "on",
    ])) as Record<ReadArea, AreaState>;
    return { expiresAt: stored ? stored.expiresAt : null, grantCid: stored ? stored.cid : null, areas };
  }

  /**
   * Turns `area` on with a grant the owner signed for it and every area that is on. The grant is checked, then
   * activated once so the node confirms the owner's authority, then stored in place of any earlier one. The owner's
   * browser revokes the grant it replaces.
   */
  async enable(address: string, area: ReadArea, envelope: GrantEnvelope): Promise<ReadStatus> {
    const owner = checkAddress(address);
    const now = this.#now();
    const previous = await this.#load(owner);
    const kept = previous && previous.expiresAt > now ? previous.areas : [];
    const areas = READ_AREA_NAMES.filter(name => name === area || kept.includes(name));
    const verified = await this.#check(owner, envelope, areas, now);
    if (!verified.ok) throw new ReadGrantInvalid(verified.code);
    if (verified.verified.expiresAt.getTime() > now + READ_GRANT_MAX_MS + CLOCK_SLACK_MS) throw new ReadGrantInvalid("expiry_too_long");
    try {
      for (const path of activationPaths(area)) await this.#activate(this.#only(verified.verified, area, path));
    } catch (error) {
      throw new ReadGrantInvalid(error instanceof DelegationActivationError && error.status < 500 ? "rejected" : "unavailable");
    }
    await this.#save(owner, { v: 1, areas, cid: verified.verified.cid, expiresAt: verified.verified.expiresAt.getTime(), ...envelope });
    this.#activations.clear();
    return this.status(owner);
  }

  /** Turns `area` off. With no area left on, the stored grant is deleted; the owner's browser revokes it at the node. */
  async disable(address: string, area: ReadArea): Promise<ReadStatus> {
    const owner = checkAddress(address);
    const stored = await this.#load(owner);
    if (stored) {
      const areas = stored.areas.filter(name => name !== area);
      this.#activations.clear();
      if (areas.length > 0) await this.#save(owner, { ...stored, areas });
      else await this.#store.delete(this.#keyFor(owner));
    }
    return this.status(owner);
  }

  /**
   * Access to one area's resources for one read. Refused unless the owner turned the area on and the stored grant
   * still passes every check: owner-signed, delegated to TrustBot's read identity, read-only, unexpired. `path`
   * narrows the access to that one resource of the area; an area with more than one SQL database needs it.
   */
  async access(address: string, area: ReadArea, path?: string): Promise<ReadAccess> {
    if (path === undefined ? activationPaths(area)[0] !== undefined : !(READ_AREAS[area] as readonly ReadResource[]).some(entry => entry.path === path)) {
      throw new Error("trustbot_read_path_invalid");
    }
    const owner = checkAddress(address);
    let auditOutcome: StandingReadPolicyRefusal | undefined;
    const standing = await this.#standing?.access(owner, area, path, outcome => { auditOutcome = outcome; });
    if (standing?.state === "active") return standing.access;
    let stored: StoredReads | undefined;
    try { stored = await this.#load(owner); } catch { throw new ReadGrantRefused("unavailable"); }
    if (!stored) throw new ReadGrantRefused(
      standing?.state === "unavailable" || standing?.state === "ended" ? standing.state : "none", auditOutcome,
    );
    if (!stored.areas.includes(area)) throw new ReadGrantRefused("off");
    const now = this.#now();
    if (stored.expiresAt <= now) throw new ReadGrantRefused("ended", auditOutcome === "no_grant" ? undefined : auditOutcome);
    const verified = await this.#check(owner, stored, stored.areas, now);
    if (!verified.ok) throw new ReadGrantRefused(verified.code === "expired" || verified.code === "session_expired" ? "ended" : "rejected");
    const cacheKey = `${owner}\n${verified.verified.cid}\n${area}\n${path ?? ""}`;
    const cached = this.#activations.get(cacheKey);
    if (cached && cached.until > now) return cached.access;
    try {
      const access = await this.#activate(this.#only(verified.verified, area, path));
      this.#activations.set(cacheKey, { access, until: Math.min(now + ACTIVATION_REUSE_MS, verified.verified.expiresAt.getTime()) });
      return access;
    } catch (error) {
      throw new ReadGrantRefused(error instanceof DelegationActivationError && error.status < 500 ? "rejected" : "unavailable");
    }
  }

  /** A failed read may mean the node refused the activation: the next read activates again. */
  forgetActivation(address: string): void {
    const owner = address.toLowerCase();
    for (const key of this.#activations.keys()) if (key.startsWith(`${owner}\n`)) this.#activations.delete(key);
  }

  #check(owner: string, envelope: GrantEnvelope, areas: readonly ReadArea[], now: number) {
    return this.#verify({
      serialized: envelope.serialized, siwe: envelope.siwe, signature: envelope.signature, address: owner,
      backendDid: this.#reader.did, configuredHost: this.#host, now, policy: "trustbot-read", expected: areaResources(areas),
    }, { computeDelegationCid: authorization => this.#reader.computeDelegationCid(authorization) });
  }

  /** The checked grant, narrowed to the resources one area reads, or to one of them when `path` is given. */
  #only(verified: VerifiedTranscriptWriter, area: ReadArea, path?: string): VerifiedTranscriptWriter {
    const wanted = (READ_AREAS[area] as readonly ReadResource[]).filter(entry => path === undefined || entry.path === path);
    const resources = verified.resources
      .filter(resource => wanted.some(entry => entry.service === resource.service && entry.path === resource.path))
      .map(resource => ({ ...resource, actions: resource.actions.filter(action => wanted.some(entry =>
        entry.service === resource.service && entry.path === resource.path && entry.actions.includes(action))) }));
    return { ...verified, resources };
  }

  #keyFor(owner: string): string {
    return `${TRUSTBOT_READ_GRANT_KEY_PREFIX}${owner}`;
  }

  async #load(owner: string): Promise<StoredReads | undefined> {
    const key = this.#keyFor(owner);
    const sealed = await this.#store.get(key);
    if (sealed === undefined) return undefined;
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(bytes.subarray(-16));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
    if (!isStored(value)) throw new Error("trustbot_read_record_invalid");
    return value;
  }

  async #save(owner: string, record: StoredReads): Promise<void> {
    const key = this.#keyFor(owner);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(key));
    const sealed = Buffer.concat([nonce, cipher.update(JSON.stringify(record)), cipher.final(), cipher.getAuthTag()]);
    await this.#store.put(key, sealed.toString("base64"));
  }
}
