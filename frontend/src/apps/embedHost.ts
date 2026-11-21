// One's side of the embed protocol, free of React and the SDK so every
// acceptance rule is testable. The screen supplies the SDK calls and the ask card through `EmbedHostDeps`.

import type { PermissionEntry } from "@tinycloud/web-sdk";
import type { FramedOneApp, OneAppOwner } from "./registry";
import { bySpace, clampRequest, resolveCeiling, scopeKey, type ResolvedEntry } from "./scope";
import type { ScopeId } from "./strings";

export type EmbedTheme = "light" | "dark";

/** One delegation for one space, ready to post. */
export interface SpaceGrant {
  spaceId: string;
  cid: string;
  /** `serializeDelegation` output. */
  delegation: string;
  expiresAt: number;
  /** True when the SDK had to ask the wallet; One then discards the grant (silent means silent). */
  prompted: boolean;
}

/** `delegate` throws this when the node does not host `spaceId`: the grant leaves that space out; nothing creates it. */
export class SpaceNotHostedError extends Error {
  constructor(readonly spaceId: string) {
    super(`one_apps_space_not_hosted:${spaceId}`);
    this.name = "SpaceNotHostedError";
  }
}

/** The name part of a space id (`tinycloud:pkh:eip155:1:0xabc:secrets` → `secrets`). */
export const spaceName = (spaceId: string) => spaceId.slice(spaceId.lastIndexOf(":") + 1);

export interface EmbedHostDeps {
  app: FramedOneApp;
  owner: OneAppOwner;
  /** The frame's window right now (`iframe.contentWindow`). */
  frameWindow(): unknown;
  /** Posts to the frame with targetOrigin = `app.origin`. */
  post(message: HostMessage): void;
  holds(entries: PermissionEntry[]): boolean;
  /**
   * `tcw.delegateTo(audience, entries, { expiry: 1h, disableSubDelegation: true, requireActivation: true })` for one
   * space. Throws `SpaceNotHostedError` when the node skips the space (it isn't set up).
   */
  delegate(audience: string, entries: PermissionEntry[]): Promise<SpaceGrant>;
  // No revoke: the SDK revokes with the owner's wallet, so every revoke asked OpenKey for a signature (TC-3483).
  // A grant is terminal, lasts an hour and goes to a key that lives only in the frame's memory.
  /**
   * Shows the ask card for `scopes` (the spaces that exist), noting `missing` (space names known not to be set up);
   * on Continue runs the OpenKey step-up for `entries`. True once One holds them.
   */
  stepUp(scopes: ScopeId[], entries: PermissionEntry[], missing: string[]): Promise<boolean>;
  /**
   * Tells the person the app asked for spaces that aren't set up (space names). `none`: nothing it asked for exists,
   * so there is nothing to approve.
   */
  missing(spaces: string[], none: boolean): void;
  theme(): EmbedTheme;
  onError?(error: unknown): void;
}

export type HostMessage =
  | { v: 1; type: "tc-embed/grant"; nonce: string; grants: Array<{ spaceId: string; delegation: string; cid: string }>; expiresAt: number; theme: EmbedTheme }
  | { v: 1; type: "tc-embed/denied"; nonce: string }
  | { v: 1; type: "tc-embed/revoke" }
  | { v: 1; type: "tc-embed/theme"; theme: EmbedTheme };

type ChildMessage =
  | { type: "hello"; appId: string; sessionDid: string; nonce: string }
  | { type: "request"; nonce: string; permissions: PermissionEntry[] };

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}(#z[1-9A-HJ-NP-Za-km-z]{40,60})?$/;
const MAX_REQUESTED = 64;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parsePermission(value: unknown): PermissionEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { service, space, path, actions } = value;
  if (typeof service !== "string" || typeof path !== "string") return undefined;
  if (space !== undefined && typeof space !== "string") return undefined;
  if (!Array.isArray(actions) || actions.length === 0 || !actions.every((action) => typeof action === "string")) return undefined;
  return { service, path, actions, ...(space === undefined ? {} : { space }) };
}

/** The child message `data` is, or undefined for anything malformed or not version 1. */
export function parseChildMessage(data: unknown): ChildMessage | undefined {
  if (!isRecord(data) || data.v !== 1 || typeof data.nonce !== "string" || !NONCE.test(data.nonce)) return undefined;
  if (data.type === "tc-embed/hello") {
    if (typeof data.appId !== "string" || typeof data.sessionDid !== "string" || !SESSION_DID.test(data.sessionDid)) return undefined;
    return { type: "hello", appId: data.appId, sessionDid: data.sessionDid, nonce: data.nonce };
  }
  if (data.type === "tc-embed/request") {
    if (!Array.isArray(data.permissions) || data.permissions.length === 0 || data.permissions.length > MAX_REQUESTED) return undefined;
    const permissions = data.permissions.map(parsePermission);
    if (permissions.some((entry) => entry === undefined)) return undefined;
    return { type: "request", nonce: data.nonce, permissions: permissions as PermissionEntry[] };
  }
  return undefined;
}

interface LiveGrant {
  key: string;
}

export interface IncomingMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export class EmbedHost {
  private readonly ceiling: ResolvedEntry[];
  private sessionDid: string | undefined;
  private live: LiveGrant | undefined;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  /** Space ids the node reported as not hosted on the latest delegation to them. */
  private readonly missingSpaces = new Set<string>();

  constructor(private readonly deps: EmbedHostDeps) {
    this.ceiling = resolveCeiling(deps.owner, deps.app.ceiling(deps.owner));
  }

  /** Feed every `message` event here. Acts only on the app's exact origin, from its frame's window. */
  handle(event: IncomingMessage): Promise<void> {
    if (this.closed || event.origin !== this.deps.app.origin) return this.queue;
    const source = this.deps.frameWindow();
    if (!source || event.source !== source) return this.queue;
    const message = parseChildMessage(event.data);
    if (!message) return this.queue;
    this.queue = this.queue.then(() => this.process(message)).catch((error: unknown) => this.deps.onError?.(error));
    return this.queue;
  }

  /** Pushes One's theme to a frame that has said hello. */
  setTheme(theme: EmbedTheme): void {
    if (this.closed || this.sessionDid === undefined) return;
    this.deps.post({ v: 1, type: "tc-embed/theme", theme });
  }

  /** Frame closed, app switched, signed out or session changed: tell the child to drop its key. Grants expire on their own. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.live = undefined;
    if (this.sessionDid !== undefined) this.deps.post({ v: 1, type: "tc-embed/revoke" });
  }

  private async process(message: ChildMessage): Promise<void> {
    if (this.closed) return;
    if (message.type === "hello") return this.hello(message);
    return this.request(message);
  }

  private heldScope(): ResolvedEntry[] {
    return this.ceiling.filter((entry) => this.deps.holds([entry.permission]));
  }

  private async hello(message: Extract<ChildMessage, { type: "hello" }>): Promise<void> {
    if (message.appId !== this.deps.app.id) return;
    // The frame's session key is fixed by its first hello until it unmounts; a different one is not this child.
    if (this.sessionDid !== undefined && message.sessionDid !== this.sessionDid) return;
    this.sessionDid = message.sessionDid;
    const scope = this.heldScope();
    // A repeat hello is a re-grant ask: only the same authority as the live grant, silently.
    if (this.live && scopeKey(scope) !== this.live.key) return;
    await this.grant(scope, message.nonce);
  }

  private async request(message: Extract<ChildMessage, { type: "request" }>): Promise<void> {
    if (this.sessionDid === undefined) return;
    const asked = clampRequest(this.deps.owner, this.ceiling, message.permissions);
    if (!asked) {
      this.deps.post({ v: 1, type: "tc-embed/denied", nonce: message.nonce });
      return;
    }
    const askedSpaces = [...new Set(asked.flatMap(({ permission }) => (permission.space === undefined ? [] : [permission.space])))];
    await this.recheckMissing(askedSpaces.filter((spaceId) => this.missingSpaces.has(spaceId)));
    if (this.closed) return;
    // Known before signing (a silent grant was refused there): never put to OpenKey, named on the card instead.
    const knownMissing = askedSpaces.filter((spaceId) => this.missingSpaces.has(spaceId));
    const approvable = asked.filter(({ permission }) => permission.space === undefined || !this.missingSpaces.has(permission.space));
    if (approvable.length === 0) {
      this.deps.missing(knownMissing.map(spaceName), true);
      this.deps.post({ v: 1, type: "tc-embed/denied", nonce: message.nonce });
      return;
    }
    const needed = approvable.filter((entry) => !this.deps.holds([entry.permission]));
    if (needed.length > 0) {
      const scopes = [...new Set(approvable.map((entry) => entry.scope))];
      const approved = await this.deps.stepUp(scopes, needed.map((entry) => entry.permission), knownMissing.map(spaceName));
      if (this.closed) return;
      if (!approved) {
        this.deps.post({ v: 1, type: "tc-embed/denied", nonce: message.nonce });
        return;
      }
    } else if (knownMissing.length > 0) {
      this.deps.missing(knownMissing.map(spaceName), false);
    }
    const skipped = await this.grant(this.heldScope(), message.nonce);
    if (skipped === undefined || this.closed) return;
    // Found only once the node saw the approved scope (post-activation): said after the fact.
    const foundMissing = askedSpaces.filter((spaceId) => skipped.includes(spaceId) && !knownMissing.includes(spaceId));
    if (foundMissing.length > 0) {
      const noneGranted = askedSpaces.every((spaceId) => skipped.includes(spaceId)) && asked.every(({ permission }) => permission.space !== undefined);
      this.deps.missing(foundMissing.map(spaceName), noneGranted);
    }
  }

  /** Spaces may have been set up since (in another tab): a silent delegation to each tells. */
  private async recheckMissing(spaceIds: string[]): Promise<void> {
    if (spaceIds.length === 0) return;
    const audience = this.sessionDid!.split("#")[0];
    const held = bySpace(this.heldScope());
    for (const spaceId of spaceIds) {
      const entries = held.get(spaceId);
      if (!entries) continue;
      try {
        await this.deps.delegate(audience, entries);
        this.missingSpaces.delete(spaceId);
      } catch (error) {
        if (!(error instanceof SpaceNotHostedError)) throw error;
      }
    }
  }

  /**
   * Delegates `scope` space by space and posts the grant, which the child takes in place of the one before. A space
   * the node doesn't host is left out and remembered as missing. Returns the skipped space ids, or undefined when
   * nothing was sent.
   */
  private async grant(scope: ResolvedEntry[], nonce: string): Promise<string[] | undefined> {
    const audience = this.sessionDid!.split("#")[0];
    const made: SpaceGrant[] = [];
    const skipped: string[] = [];
    for (const [spaceId, entries] of bySpace(scope)) {
      let grant: SpaceGrant;
      try {
        grant = await this.deps.delegate(audience, entries);
      } catch (error) {
        if (!(error instanceof SpaceNotHostedError)) throw error;
        skipped.push(spaceId);
        continue;
      }
      made.push(grant);
      if (grant.prompted || this.closed) return undefined;
    }
    for (const spaceId of bySpace(scope).keys()) {
      if (skipped.includes(spaceId)) this.missingSpaces.add(spaceId);
      else this.missingSpaces.delete(spaceId);
    }
    const expiresAt = made.length > 0 ? Math.min(...made.map((grant) => grant.expiresAt)) : Date.now() + 60 * 60 * 1000;
    this.deps.post({
      v: 1,
      type: "tc-embed/grant",
      nonce,
      grants: made.map(({ spaceId, delegation, cid }) => ({ spaceId, delegation, cid })),
      expiresAt,
      theme: this.deps.theme(),
    });
    this.live = { key: scopeKey(scope) };
    return skipped;
  }
}
