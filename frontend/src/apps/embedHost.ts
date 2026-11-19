// One's side of the embed protocol (CONTRACT.md "Messages" and "Delegation"), free of React and the SDK so every
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

export interface EmbedHostDeps {
  app: FramedOneApp;
  owner: OneAppOwner;
  /** The frame's window right now (`iframe.contentWindow`). */
  frameWindow(): unknown;
  /** Posts to the frame with targetOrigin = `app.origin`. */
  post(message: HostMessage): void;
  holds(entries: PermissionEntry[]): boolean;
  /** `tcw.delegateTo(audience, entries, { expiry: 1h, disableSubDelegation: true })` for one space. */
  delegate(audience: string, entries: PermissionEntry[]): Promise<SpaceGrant>;
  revoke(cid: string): Promise<void>;
  /** Shows the ask card for `scopes`; on Continue runs the OpenKey step-up for `entries`. True once One holds them. */
  stepUp(scopes: ScopeId[], entries: PermissionEntry[]): Promise<boolean>;
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
  cids: string[];
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

  /** Frame closed, app switched, signed out or session changed: revoke every live grant and tell the child. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cids = this.live?.cids ?? [];
    this.live = undefined;
    if (this.sessionDid !== undefined) this.deps.post({ v: 1, type: "tc-embed/revoke" });
    await Promise.allSettled(cids.map((cid) => this.deps.revoke(cid)));
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
    const missing = asked.filter((entry) => !this.deps.holds([entry.permission]));
    if (missing.length > 0) {
      const approved = await this.deps.stepUp([...new Set(asked.map((entry) => entry.scope))], missing.map((entry) => entry.permission));
      if (this.closed) return;
      if (!approved) {
        this.deps.post({ v: 1, type: "tc-embed/denied", nonce: message.nonce });
        return;
      }
    }
    await this.grant(this.heldScope(), message.nonce);
  }

  private async grant(scope: ResolvedEntry[], nonce: string): Promise<void> {
    const audience = this.sessionDid!.split("#")[0];
    const made: SpaceGrant[] = [];
    const discard = () => Promise.allSettled(made.map((grant) => this.deps.revoke(grant.cid)));
    try {
      for (const entries of bySpace(scope).values()) {
        const grant = await this.deps.delegate(audience, entries);
        made.push(grant);
        if (grant.prompted || this.closed) {
          await discard();
          return;
        }
      }
    } catch (error) {
      await discard();
      throw error;
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
    const replaced = this.live?.cids ?? [];
    this.live = { key: scopeKey(scope), cids: made.map((grant) => grant.cid) };
    await Promise.allSettled(replaced.map((cid) => this.deps.revoke(cid)));
  }
}
