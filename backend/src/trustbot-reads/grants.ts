// TrustBot's read grants: one delegation per owner, signed in the owner's browser to TrustBot's own read identity,
// read-only, for at most 7 days. The grant names the resources of every area the owner turned on (areas.ts). It is
// stored sealed in the backend's own space and checked again, then activated, on every read.
// Details: TC-3792
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { DelegatedAccess, TinyCloudNode } from "@tinycloud/node-sdk";
import { verifyTranscriptWriterGrant, type VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation, DelegationActivationError } from "../portable-delegation.js";
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
  constructor(readonly code: ReadRefusal) { super(`trustbot_read_${code}`); this.name = "ReadGrantRefused"; }
}
/** The grant the owner sent does not match what turning the area on needs. */
export class ReadGrantInvalid extends Error {
  constructor(readonly code: string) { super(`trustbot_read_grant_${code}`); this.name = "ReadGrantInvalid"; }
}

interface StoredReads extends GrantEnvelope {
  v: 1;
  areas: ReadArea[];
  /** Kept even when all read areas are off. Missing in records created before per-chat settings. */
  deniedChatIds?: string[];
  cid: string;
  expiresAt: number;
  mintedAt?: number;
  replacedGrantCid?: string;
}
interface ReadGrantRecord { record: StoredReads; etag: string }
type WriteCondition = { ifMatch: string } | { ifNoneMatch: "*" };

/** The backend store supplies an ETag for conditional writes. In-memory stores may supply just the sealed value. */
export interface ReadGrantStore {
  get(key: string): Promise<string | { value: string; etag: string } | undefined>;
  put(key: string, value: string, condition: WriteCondition): Promise<boolean | void>;
  delete(key: string, condition: { ifMatch: string }): Promise<boolean | void>;
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
  return v.v === 1 && Array.isArray(v.areas) && v.areas.every(isReadArea)
    && (v.deniedChatIds === undefined || (Array.isArray(v.deniedChatIds)
      && v.deniedChatIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)))
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
  readonly #verify: typeof verifyTranscriptWriterGrant;
  readonly #activate: (verified: VerifiedTranscriptWriter) => Promise<ReadAccess>;
  readonly #activations = new Map<string, { access: ReadAccess; until: number }>();

  constructor(options: TrustBotReadGrantsOptions) {
    this.#reader = options.reader;
    this.#store = options.store;
    this.#host = options.host;
    this.#key = Buffer.from(hkdfSync("sha256", options.sealSecret, Buffer.alloc(0), "tinychat.trustbot-reads.grants/v1", 32));
    this.#now = options.now ?? Date.now;
    this.#verify = options.verify ?? verifyTranscriptWriterGrant;
    this.#activate = options.activate ?? (verified => activateVerifiedDelegation(this.#reader as TinyCloudNode, verified, { host: this.#host }));
  }

  /** The DID the owner delegates to. */
  get serviceDid(): string {
    return this.#reader.did;
  }

  /** Each area's state for this owner, and when the grant ends. */
  async status(address: string): Promise<ReadStatus> {
    return this.#status((await this.#load(checkAddress(address)))?.record);
  }

  /** Authoritative per-chat settings, loaded afresh for each read; corrupt records fail closed. */
  async deniedChatIds(address: string): Promise<Set<string>> {
    return new Set((await this.#load(checkAddress(address)))?.record.deniedChatIds ?? []);
  }

  async setChatDenied(address: string, chat: string, denied: boolean): Promise<Set<string>> {
    const owner = checkAddress(address);
    if (typeof chat !== "string" || chat.length === 0 || chat.length > 128 || typeof denied !== "boolean") throw new ReadGrantInvalid("invalid_chat");
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await this.#load(owner);
      const ids = new Set(stored?.record.deniedChatIds ?? []);
      if (denied) ids.add(chat); else ids.delete(chat);
      if (!stored && ids.size === 0) return ids;
      // With no grant yet, retain only off settings and an empty envelope; access refuses the empty areas.
      const next: StoredReads = { ...(stored?.record ?? {
        v: 1, areas: [], cid: "", expiresAt: 0, serialized: "", siwe: "", signature: "",
      }), deniedChatIds: [...ids] };
      if (await this.#save(owner, next, stored?.etag) !== false) return ids;
    }
    throw new ReadGrantInvalid("changed");
  }

  async renewalStatus(address: string): Promise<ReadStatus & { renewAfter: number | null; replacedGrantCid: string | null }> {
    const stored = (await this.#load(checkAddress(address)))?.record;
    // Existing records predate mintedAt. The seven-day cap gives an early bound for those grants.
    const lifetime = stored?.mintedAt === undefined ? READ_GRANT_MAX_MS : stored.expiresAt - stored.mintedAt;
    const renewAfter = stored ? stored.expiresAt - lifetime / 2 : null;
    return { ...this.#status(stored), renewAfter, replacedGrantCid: stored?.replacedGrantCid ?? null };
  }

  #status(stored: StoredReads | undefined): ReadStatus {
    if (stored?.areas.length === 0) stored = undefined;
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
    const kept = previous && previous.record.expiresAt > now ? previous.record.areas : [];
    const areas = READ_AREA_NAMES.filter(name => name === area || kept.includes(name));
    return this.#replace(owner, envelope, { areas, activateAreas: [area], now, previous });
  }

  /** Replaces the current grant for exactly the areas the owner has left enabled. */
  async renew(address: string, cid: string, envelope: GrantEnvelope): Promise<ReadStatus> {
    const owner = checkAddress(address);
    const previous = await this.#load(owner);
    if (!previous || previous.record.cid !== cid) throw new ReadGrantInvalid("changed");
    const areas = previous.record.areas;
    return this.#replace(owner, envelope, { areas, activateAreas: areas, now: this.#now(), previous, renewing: true });
  }

  async #replace(owner: string, envelope: GrantEnvelope, options: {
    areas: ReadArea[]; activateAreas: ReadArea[]; now: number; previous?: ReadGrantRecord; renewing?: boolean;
  }): Promise<ReadStatus> {
    const { areas, activateAreas, now, previous, renewing } = options;
    const verified = await this.#check(owner, envelope, areas, now);
    if (!verified.ok) throw new ReadGrantInvalid(verified.code);
    const expiresAt = verified.verified.expiresAt.getTime();
    const maxExpiry = now + READ_GRANT_MAX_MS + (renewing ? 0 : CLOCK_SLACK_MS);
    if (expiresAt > maxExpiry) throw new ReadGrantInvalid("expiry_too_long");
    if (renewing && previous && expiresAt <= previous.record.expiresAt) throw new ReadGrantInvalid("expiry_not_extended");
    try {
      for (const area of activateAreas) {
        for (const path of activationPaths(area)) await this.#activate(this.#only(verified.verified, area, path));
      }
    } catch (error) {
      throw new ReadGrantInvalid(error instanceof DelegationActivationError && error.status < 500 ? "rejected" : "unavailable");
    }
    const cid = verified.verified.cid;
    const record: StoredReads = { v: 1, areas, cid, expiresAt, mintedAt: now, ...envelope, deniedChatIds: previous?.record.deniedChatIds ?? [] };
    // Keep the superseded CID with the committed grant so the owner can revoke it if the response was lost.
    record.replacedGrantCid = previous?.record.cid === cid ? previous.record.replacedGrantCid : previous?.record.cid;
    if (await this.#save(owner, record, previous?.etag) === false) throw new ReadGrantInvalid("changed");
    this.#activations.clear();
    return this.#status(record);
  }

  /** Turns `area` off. With no area left on, delete the grant unless per-chat settings must be retained. */
  async disable(address: string, area: ReadArea): Promise<ReadStatus> {
    const owner = checkAddress(address);
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await this.#load(owner);
      if (!stored || !stored.record.areas.includes(area)) return this.#status(stored?.record);
      const areas = stored.record.areas.filter(name => name !== area);
      const next = { ...stored.record, areas };
      const retained = areas.length > 0 || (next.deniedChatIds?.length ?? 0) > 0;
      const written = retained
        ? await this.#save(owner, next, stored.etag)
        : await this.#store.delete(this.#keyFor(owner), { ifMatch: stored.etag });
      if (written === false) continue;
      this.#activations.clear();
      return this.#status(areas.length > 0 ? next : undefined);
    }
    throw new ReadGrantInvalid("changed");
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
    let stored: StoredReads | undefined;
    try { stored = (await this.#load(owner))?.record; } catch { throw new ReadGrantRefused("unavailable"); }
    if (!stored) throw new ReadGrantRefused("none");
    if (!stored.areas.includes(area)) throw new ReadGrantRefused("off");
    const now = this.#now();
    if (stored.expiresAt <= now) throw new ReadGrantRefused("ended");
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

  async #load(owner: string): Promise<ReadGrantRecord | undefined> {
    const key = this.#keyFor(owner);
    const stored = await this.#store.get(key);
    if (stored === undefined) return undefined;
    const { value: sealed, etag } = typeof stored === "string" ? { value: stored, etag: "" } : stored;
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(bytes.subarray(-16));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
    if (!isStored(value)) throw new Error("trustbot_read_record_invalid");
    return { record: value, etag };
  }

  async #save(owner: string, record: StoredReads, etag?: string): Promise<boolean | void> {
    const key = this.#keyFor(owner);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(key));
    const sealed = Buffer.concat([nonce, cipher.update(JSON.stringify(record)), cipher.final(), cipher.getAuthTag()]);
    return this.#store.put(key, sealed.toString("base64"), etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: etag });
  }
}
