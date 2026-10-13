import type { NativeSession, OpenKeyNative } from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { voiceNoteSaveBusy, whenVoiceNoteSavesIdle } from "./voiceNotes/recorderSaves";
import { schedulePendingVoiceNotesRecovery } from "../chat/PendingVoiceNotesSaver";

export const NATIVE_SESSION_ENDED_MESSAGE = "Your OpenKey session ended — sign in again.";
export const NATIVE_STORAGE_MESSAGE = "Couldn't access secure storage on this device. Please try again.";
export const NATIVE_RENEWAL_UNAVAILABLE_MESSAGE = "Can't renew your OpenKey session right now. We'll retry automatically.";

type Delegation = NativeSession["delegation"];
type Verified = { token: string; expiresIn: number; address: string };

function expiryMs(value: string | number): number {
  return typeof value === "number" ? value * 1000 : Date.parse(value);
}

/** Same lifetime-bounded lead used by the approved SDK's delegationNeedsRenewalNow. */
export function renewalLeadMs(delegation: Pick<Delegation, "issuedAt" | "expiresAt">): number {
  const expires = expiryMs(delegation.expiresAt);
  const issued = delegation.issuedAt ? Date.parse(delegation.issuedAt) : NaN;
  return Math.min(600_000, Number.isFinite(issued) && issued < expires ? (expires - issued) / 4 : 600_000);
}

export function nativeRenewAt(session: NativeSession, jitterMs = 0): number {
  const delegation = session.delegation;
  const issued = delegation.issuedAt ? Date.parse(delegation.issuedAt) : NaN;
  const minimum = Number.isFinite(issued) ? issued + Math.min(60_000, renewalLeadMs(delegation)) : 0;
  return Math.max(expiryMs(delegation.expiresAt) - renewalLeadMs(delegation), minimum) + Math.max(0, Math.min(10_000, jitterMs));
}

export function nativeRetryDelay(error: unknown, attempt: number, remainingMs: number): number | null {
  const code = nativeCode(error);
  if (code === "RENEWAL_TOO_SOON") {
    const seconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }
  const backoff = Math.min(300_000, 15_000 * 2 ** Math.min(attempt, 5));
  const seconds = (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
  // A 503's Retry-After adds a lower bound; it never removes the plan's 15 s floor.
  if (code === "TEMPORARILY_UNAVAILABLE" && typeof seconds === "number" && Number.isFinite(seconds)) {
    return Math.max(backoff, seconds * 1000);
  }
  // Unknown failures are still recoverable. Keep retrying with a capped delay,
  // including after the old delegation expires, and make the failure visible.
  void remainingMs;
  return backoff;
}

export function nativeCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

export function terminalRenewalError(error: unknown): boolean {
  return ["INVALID_GRANT", "CONSENT_REQUIRED", "ACCESS_DENIED", "SPACE_UNAVAILABLE"].includes(nativeCode(error) ?? "");
}

export interface NativeRenewalDeps {
  openkey: Pick<OpenKeyNative, "renew" | "current"> & Partial<Pick<OpenKeyNative, "signOut">>;
  tcw: TinyCloudWeb;
  session: NativeSession;
  sessionStore: Pick<SessionStore, "setSession">;
  requestNonce: (address: string) => Promise<string>;
  verifySession: (siwe: string, signature: string) => Promise<Verified>;
  install: (session: NativeSession, tcw: TinyCloudWeb) => Promise<void>;
  onTerminal: (message: string) => void;
  onStorage: (message: string) => void;
  onUnavailable?: (message: string) => void;
  saveBusy?: () => boolean;
  whenSaveIdle?: () => Promise<void>;
  recoverPendingSave?: () => void;
  now?: () => number;
  jitter?: () => number;
}

export class NativeRenewal {
  private session: NativeSession;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private pendingInstall: NativeSession | null = null;
  private retryAttempt = 0;
  private retryNotBefore = 0;
  private stopped = false;
  private generation = 0;
  private renewAtOverride: number | null = null;
  private readonly now: () => number;
  private readonly saveBusy: () => boolean;
  private readonly whenSaveIdle: () => Promise<void>;
  private readonly recoverPendingSave: () => void;

  constructor(private readonly deps: NativeRenewalDeps) {
    this.session = deps.session;
    this.now = deps.now ?? Date.now;
    this.saveBusy = deps.saveBusy ?? voiceNoteSaveBusy;
    this.whenSaveIdle = deps.whenSaveIdle ?? whenVoiceNoteSavesIdle;
    this.recoverPendingSave = deps.recoverPendingSave ?? schedulePendingVoiceNotesRecovery;
  }

  start(renewAtOverride?: number): void {
    this.renewAtOverride = renewAtOverride ?? null;
    this.schedule(this.nextRenewAt());
  }
  stop(): void { this.stopped = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async resume(): Promise<void> {
    this.stopped = false;
    this.generation++;
    const generation = this.generation;
    this.flight = null;
    try {
      const current = await this.deps.openkey.current();
      if (this.stopped || generation !== this.generation) return;
      if (current && current.delegation.delegationCid !== this.session.delegation.delegationCid) {
        this.pendingInstall = current;
        this.retryNotBefore = 0;
      }
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      if (nativeCode(error) === "STORAGE") this.deps.onStorage(NATIVE_STORAGE_MESSAGE);
    }
    this.schedule(this.pendingInstall ? this.now() : Math.max(this.nextRenewAt(), this.retryNotBefore));
  }
  private nextRenewAt(): number { return Math.min(nativeRenewAt(this.session, this.deps.jitter?.() ?? Math.random() * 10_000), this.renewAtOverride ?? Infinity); }
  /** Foreground and guarded TinyCloud calls use the same single flight as the timer. */
  check(_force = false): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("OpenKey session is signed out"));
    if (this.now() < this.retryNotBefore) {
      return this.now() >= expiryMs(this.session.delegation.expiresAt)
        ? Promise.reject(new Error("OpenKey renewal is temporarily unavailable")) : Promise.resolve();
    }
    if (this.retryNotBefore === 0 && this.now() < Math.min(nativeRenewAt(this.session), this.renewAtOverride ?? Infinity) && !this.pendingInstall) return Promise.resolve();
    if (!this.flight) {
      const generation = this.generation;
      const flight = this.run(generation).finally(() => { if (this.flight === flight) this.flight = null; });
      this.flight = flight;
    }
    // A save's next part must be able to use the old, still-valid graph while
    // network renewal and the deferred install continue in the background.
    if (this.saveBusy() && this.now() < expiryMs(this.session.delegation.expiresAt) - 60_000) return Promise.resolve();
    return this.flight.then(() => {
      if (this.now() >= expiryMs(this.session.delegation.expiresAt)) {
        throw new Error("OpenKey renewal is temporarily unavailable");
      }
    });
  }

  private schedule(at: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.check().catch(() => {}); }, Math.max(0, at - this.now()));
  }

  private async run(generation: number): Promise<void> {
    const active = () => !this.stopped && generation === this.generation;
    try {
      if (!this.pendingInstall) {
        let nonce: string | undefined;
        try { nonce = await this.deps.requestNonce(this.session.delegation.address!); }
        catch { /* A backend outage must not block OpenKey renewal. */ }
        if (!active()) return;
        this.pendingInstall = await this.deps.openkey.renew(nonce ? { siweNonce: nonce } : {});
        if (!active()) return;
      }
      const next = this.pendingInstall;
      const forceAt = expiryMs(this.session.delegation.expiresAt) - 60_000;
      if (this.saveBusy() && this.now() < forceAt) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.whenSaveIdle(),
            new Promise<void>((resolve) => { deadline = setTimeout(resolve, Math.max(0, forceAt - this.now())); }),
          ]);
        } finally { if (deadline) clearTimeout(deadline); }
      }
      if (!active()) return;
      const forced = this.saveBusy();
      await this.deps.install(next, this.deps.tcw);
      if (!active()) return;
      this.session = next;
      this.pendingInstall = null;
      this.renewAtOverride = null;
      if (forced) void this.whenSaveIdle().then(() => this.recoverPendingSave());
      const verified = await this.deps.verifySession(next.delegation.siwe!, next.delegation.signature!);
      if (!active()) return;
      this.deps.sessionStore.setSession(verified.token, verified.expiresIn, verified.address);
      this.retryAttempt = 0;
      this.retryNotBefore = 0;
      if (!active()) return;
      const nextAt = this.nextRenewAt();
      console.info("[OpenKey native] renewal", { code: "OK", expiresAt: next.delegation.expiresAt, nextSchedule: new Date(nextAt).toISOString() });
      this.schedule(nextAt);
    } catch (error) {
      if (!active()) return;
      if (terminalRenewalError(error)) {
        console.warn("[OpenKey native] renewal", { code: nativeCode(error), expiresAt: this.session.delegation.expiresAt, nextSchedule: null });
        this.stop();
        this.deps.onTerminal(NATIVE_SESSION_ENDED_MESSAGE);
        // A local handoff failure can carry SPACE_UNAVAILABLE without the SDK
        // having wiped its own grant, so revoke that one explicitly.
        if (nativeCode(error) === "SPACE_UNAVAILABLE") {
          void this.deps.openkey.signOut?.().catch((signOutError: unknown) => {
            if (nativeCode(signOutError) === "STORAGE") this.deps.onStorage(NATIVE_STORAGE_MESSAGE);
          });
        }
      } else if (nativeCode(error) === "STORAGE") {
        this.deps.onStorage(NATIVE_STORAGE_MESSAGE);
        this.retryNotBefore = this.now() + 15_000;
        console.warn("[OpenKey native] renewal", { code: "STORAGE", expiresAt: this.session.delegation.expiresAt, nextSchedule: new Date(this.retryNotBefore).toISOString() });
        this.schedule(this.retryNotBefore);
      } else {
        const remaining = expiryMs(this.session.delegation.expiresAt) - this.now();
        const delay = nativeRetryDelay(error, this.retryAttempt++, remaining);
        this.deps.onUnavailable?.(NATIVE_RENEWAL_UNAVAILABLE_MESSAGE);
        this.retryNotBefore = this.now() + (delay ?? 15_000);
        console.warn("[OpenKey native] renewal", { code: nativeCode(error) ?? "UNEXPECTED", expiresAt: this.session.delegation.expiresAt, nextSchedule: new Date(this.retryNotBefore).toISOString() });
        this.schedule(this.retryNotBefore);
      }
    }
  }
}

/** Intercept native KV/SQL calls at the last boundary before the SDK invocation. */
export function guardNativeTinyCloudCalls(tcw: TinyCloudWeb, renewal: NativeRenewal): TinyCloudWeb {
  // Each handle is an accessor, including handles retained by putAudio or
  // returned by db()/withPrefix(). Never bind a service from a retired graph.
  const wrap = (resolve: () => object, graph: () => object): object => new Proxy({}, {
    get(_target, key) {
      const target = resolve();
      const value = Reflect.get(target, key, target) as unknown;
      if (value && typeof value === "object") return wrap(() => {
        const current = resolve();
        return Reflect.get(current, key, current) as object;
      }, graph);
      if (typeof value !== "function") return value;
      if (key === "db" || key === "withPrefix") return (...args: unknown[]) => wrap(() => {
        const current = resolve();
        return (Reflect.get(current, key, current) as (...args: unknown[]) => object).apply(current, args);
      }, graph);
      return async (...args: unknown[]) => {
        await renewal.check();
        let invokedGraph = graph();
        const invoke = () => {
          const current = resolve();
          return (Reflect.get(current, key, current) as (...args: unknown[]) => unknown).apply(current, args);
        };
        // The 2.11 context throws this exact message from assertActive().
        // An in-flight fetch instead becomes an ABORTED service result when
        // retire() aborts the graph's controller. A caller's own abort is not
        // a session handoff, so require the root service to have changed.
        const retired = (failure: unknown): boolean => {
          if (graph() === invokedGraph) return false;
          const detail = failure && typeof failure === "object" && "error" in failure ? failure.error : failure;
          if (!detail || typeof detail !== "object") return false;
          const candidate = detail as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
          return candidate.message === "Service graph has been retired by session replacement."
            || candidate.code === "ABORTED"
            || candidate.name === "AbortError"
            || (candidate.cause !== undefined && retired(candidate.cause));
        };
        const putOptions = args[2] && typeof args[2] === "object"
          ? args[2] as { ifMatch?: unknown; ifNoneMatch?: unknown; prefix?: unknown; signal?: AbortSignal }
          : undefined;
        const callerAborted = () => args.some((arg) => {
          if (!arg || typeof arg !== "object" || !("signal" in arg)) return false;
          const signal = (arg as { signal?: AbortSignal }).signal;
          return signal?.aborted === true;
        });
        const safeToReplay = key === "get" || key === "list" || key === "head"
          || (key === "query" && typeof args[0] === "string" && /^\s*SELECT\b/i.test(args[0]))
          || (key === "put" && typeof args[0] === "string" && /\/p\/\d+$/.test(args[0])
            && !putOptions?.ifMatch && !putOptions?.ifNoneMatch && !putOptions?.prefix);
        for (let attempt = 0; attempt < 3; attempt++) {
          invokedGraph = graph();
          try {
            const result = await invoke();
            if (!retired(result)) return result;
            if (!safeToReplay || callerAborted()) return result;
          } catch (error) {
            if (!retired(error)) throw error;
            if (!safeToReplay || callerAborted()) throw error;
          }
          await renewal.check();
        }
        throw new Error("TinyCloud session changed during the request. Please try again.");
      };
    },
  });
  return new Proxy(tcw, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if ((key === "kv" || key === "sql" || key === "capabilities") && value && typeof value === "object") {
        const graph = () => Reflect.get(target, key, target) as object;
        return wrap(graph, graph);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
