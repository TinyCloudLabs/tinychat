import type { NativeSession, OpenKeyNative } from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { voiceNoteSaveBusy, whenVoiceNoteSavesIdle } from "./voiceNotes/recorderSaves";
import { schedulePendingVoiceNotesRecovery } from "../chat/PendingVoiceNotesSaver";
import { isTransientRestoreError } from "./sessionRestore";

export const NATIVE_SESSION_ENDED_MESSAGE = "Your OpenKey session ended — sign in again.";
export const NATIVE_STORAGE_MESSAGE = "Couldn't access secure storage on this device. Please try again.";

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
  if (remainingMs <= 0) return null;
  if (code === "RENEWAL_TOO_SOON" || code === "TEMPORARILY_UNAVAILABLE") {
    const seconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }
  // The SDK already reloads the secure-store token and retries a 409 once.
  if (code === "RENEWAL_CONFLICT") return null;
  if (code === "NETWORK" || code === "TEMPORARILY_UNAVAILABLE" || code === "RENEWAL_TOO_SOON" || code === "HANDOFF_RETRY" ||
    isTransientRestoreError(error) ||
    (typeof (error as { status?: unknown })?.status === "number" &&
      (Number((error as { status: number }).status) >= 500 || Number((error as { status: number }).status) === 429))) {
    return Math.max(15_000, Math.min(300_000, remainingMs / 2, 15_000 * 2 ** Math.min(attempt, 5)));
  }
  return null;
}

export function nativeCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

export function terminalRenewalError(error: unknown): boolean {
  return ["INVALID_GRANT", "CONSENT_REQUIRED", "ACCESS_DENIED", "SPACE_UNAVAILABLE", "NOT_SIGNED_IN", "RENEWAL_CONFLICT"].includes(nativeCode(error) ?? "");
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

  start(): void { this.schedule(nativeRenewAt(this.session, this.deps.jitter?.() ?? Math.random() * 10_000)); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** Foreground and guarded TinyCloud calls use the same single flight as the timer. */
  check(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (force && this.now() >= expiryMs(this.session.delegation.expiresAt)) this.retryNotBefore = 0;
    if (this.now() < this.retryNotBefore) {
      return this.now() >= expiryMs(this.session.delegation.expiresAt)
        ? Promise.reject(new Error("OpenKey renewal is temporarily unavailable")) : Promise.resolve();
    }
    if (this.now() < nativeRenewAt(this.session) && !this.pendingInstall) return Promise.resolve();
    if (!this.flight) this.flight = this.run().finally(() => { this.flight = null; });
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

  private async run(): Promise<void> {
    try {
      if (!this.pendingInstall) {
        let nonce: string | undefined;
        try { nonce = await this.deps.requestNonce(this.session.delegation.address!); }
        catch { /* A backend outage must not block OpenKey renewal. */ }
        this.pendingInstall = await this.deps.openkey.renew(nonce ? { siweNonce: nonce } : {});
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
      if (this.stopped) return;
      const forced = this.saveBusy();
      await this.deps.install(next, this.deps.tcw);
      this.session = next;
      this.pendingInstall = null;
      this.retryAttempt = 0;
      this.retryNotBefore = 0;
      if (forced) void this.whenSaveIdle().then(() => this.recoverPendingSave());
      try {
        const verified = await this.deps.verifySession(next.delegation.siwe!, next.delegation.signature!);
        this.deps.sessionStore.setSession(verified.token, verified.expiresIn, verified.address);
      } catch { /* The delegation remains usable; retry backend auth on the next renewal. */ }
      this.schedule(nativeRenewAt(next, this.deps.jitter?.() ?? Math.random() * 10_000));
    } catch (error) {
      if (this.stopped) return;
      if (terminalRenewalError(error)) {
        this.stop();
        this.deps.onTerminal(NATIVE_SESSION_ENDED_MESSAGE);
        // The SDK wipes terminal renewals itself; a failed 409 reload still
        // holds a grant, so retire it explicitly before a future boot.
        if (nativeCode(error) === "RENEWAL_CONFLICT" || nativeCode(error) === "SPACE_UNAVAILABLE") {
          void this.deps.openkey.signOut?.().catch((signOutError: unknown) => {
            if (nativeCode(signOutError) === "STORAGE") this.deps.onStorage(NATIVE_STORAGE_MESSAGE);
          });
        }
      } else if (nativeCode(error) === "STORAGE") {
        this.deps.onStorage(NATIVE_STORAGE_MESSAGE);
        this.retryNotBefore = this.now() + 15_000;
        this.schedule(this.retryNotBefore);
      } else {
        const remaining = expiryMs(this.session.delegation.expiresAt) - this.now();
        const delay = nativeRetryDelay(error, this.retryAttempt++, remaining);
        this.retryNotBefore = delay === null ? Number.POSITIVE_INFINITY : this.now() + delay;
        if (delay !== null) this.schedule(this.retryNotBefore);
      }
    }
  }
}

/** Intercept native KV/SQL calls at the last boundary before the SDK invocation. */
export function guardNativeTinyCloudCalls(tcw: TinyCloudWeb, renewal: NativeRenewal): TinyCloudWeb {
  const wrap = (service: object): object => new Proxy(service, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (key === "db" || key === "withPrefix") return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result && typeof result === "object" ? wrap(result) : result;
      };
      return async (...args: unknown[]) => { await renewal.check(); return value.apply(target, args); };
    },
  });
  return new Proxy(tcw, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if ((key === "kv" || key === "sql" || key === "capabilities") && value && typeof value === "object") return wrap(value);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
