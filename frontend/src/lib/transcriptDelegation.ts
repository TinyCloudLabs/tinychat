import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { checkDelegationStatus, sendDelegation, type SessionStore } from "@tinyboilerplate/client";
import type { DelegationResponse } from "@tinyboilerplate/core";
import { SESSION_EXPIRATION_MS, TRANSCRIPT_WRITER_PERMISSIONS } from "@tinyboilerplate/core";
import { ensureConnectorSchema } from "@tinyboilerplate/core";
import { toPortableDelegation, serializePortableDelegation } from "./agentDelegation";
import { webConnectorPort } from "./connectors/connectorPort";
import { fetchServerInfoDid } from "./backendAttestation";
import { localValidationEnabled } from "./localValidation";
import {
  beginTranscriptConsentStatus, clearTranscriptConsentStatus, resolveTranscriptConsentStatus,
  serverDeliveryActive, setServerDeliveryActive,
} from "./transcriptDeliveryState";

const DAY = 24 * 60 * 60 * 1000;
const GRANT_LIFETIME = SESSION_EXPIRATION_MS - DAY;
const ATTEMPT_TIMEOUT = 90_000;
const LEASE_LIFETIME = 120_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Promise<EnsureResult>>();
export { serverDeliveryActive };

export type EnsureResult = "active" | "disabled" | "busy" | "unavailable";

interface Options { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore }
interface Backoff { failures: number; lastFailureAt: number; jitter: number }

function sessionExpiration(siwe: string): number {
  const value = /^Expiration Time:\s*(\S+)/im.exec(siwe)?.[1];
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) throw new Error("TinyCloud session has no valid expiration time");
  return time;
}

function need(status: DelegationResponse, sessionExpiry: number, now = Date.now()): { needed: boolean; urgent: boolean } {
  const expiry = status.expiresAt ? Date.parse(status.expiresAt) : NaN;
  const remaining = Number.isFinite(expiry) ? expiry - now : -Infinity;
  const gain = Math.min(now + GRANT_LIFETIME, sessionExpiry) - expiry;
  const missing = status.status !== "active" || status.verified !== true;
  const needed = missing || (remaining < 7 * DAY && gain > DAY);
  return { needed, urgent: needed && (missing || remaining < DAY) };
}

/**
 * Only an explicit, known delivery value turns the browser courier on. A backend that omits the
 * field (or sends one this build does not know) must not trigger minting or the browser's
 * ten-minute fallback deferral. `schema_missing` is still on: it is the browser's repair cue.
 */
function deliveryEnabled(status: DelegationResponse): boolean {
  return status.delivery === "enabled" || status.delivery === "schema_missing";
}

function storage(): Storage { return localStorage; }
function readBackoff(key: string): Backoff | null {
  const raw = storage().getItem(key);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Backoff;
    if (Number.isInteger(b.failures) && b.failures > 0 && Number.isFinite(b.lastFailureAt)
      && Number.isFinite(b.jitter) && b.jitter >= 0 && b.jitter < 1) return b;
  } catch { /* Invalid/old records are reset. */ }
  storage().removeItem(key);
  return null;
}

/** Recompute from urgency on every evaluation: an urgent renewal cannot inherit a six-hour wait. */
export function nextTranscriptAttempt(backoff: Backoff | null, urgent: boolean): number {
  if (!backoff) return 0;
  const cap = urgent ? 5 * 60_000 : 6 * 60 * 60_000;
  const base = 60_000 * 2 ** Math.min(backoff.failures - 1, 20);
  return backoff.lastFailureAt + Math.min(cap, base * (1 + 0.2 * backoff.jitter));
}

function cancel(key: string): void {
  const timer = timers.get(key);
  clearTimeout(timer);
  timers.delete(key);
}

export function clearTranscriptDelegationSchedule(address: string | null): void {
  if (address) cancel(`tinychat.transcriptWriter.${address.toLowerCase()}`);
  setServerDeliveryActive(false);
  clearTranscriptConsentStatus(address);
}

function schedule(key: string, at: number, options: Options): void {
  cancel(key);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void ensureTranscriptWriterDelegation(options);
  }, Math.max(0, at - Date.now())));
}

function recordFailure(key: string, options: Options, urgent: boolean): void {
  try {
    const previous = readBackoff(key);
    const backoff: Backoff = { failures: (previous?.failures ?? 0) + 1, lastFailureAt: Date.now(), jitter: Math.random() };
    storage().setItem(key, JSON.stringify(backoff));
    if (options.sessionStore.getAddress()?.toLowerCase() === options.tcw.address()?.toLowerCase()) {
      schedule(key, nextTranscriptAttempt(backoff, urgent), options);
    }
  } catch {
    // Storage can be disabled; focus remains a retry opportunity.
  }
}

/** Error messages and objects may contain signed capability material. Log only bounded codes. */
function warningCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = "code" in error ? error.code : undefined;
  if (code === "AUTH_UNAUTHORIZED" || code === "KV_NOT_FOUND" || code === "PERMISSION_NOT_IN_MANIFEST") return code;
  const name = "name" in error ? error.name : undefined;
  if (name === "AbortError" || name === "TimeoutError" || name === "TypeError" || name === "Error") return name;
  return "unknown";
}

async function withAttemptTimeout<T>(run: (alive: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(() => { if (expired) throw new Error("Transcript delegation attempt timed out"); }, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          reject(new Error("Transcript delegation attempt timed out"));
        }, ATTEMPT_TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Once inside a cross-tab lock, re-fetch everything rather than trusting the pre-lock snapshot. */
async function underLock(options: Options, address: string, key: string, sessionExpiry: number): Promise<EnsureResult> {
  let urgent = true;
  let observed = false;
  try {
    return await withAttemptTimeout(async (alive, signal) => {
      const token = options.sessionStore.getToken();
      if (!token || options.sessionStore.isExpired() || options.sessionStore.getAddress()?.toLowerCase() !== address) {
        throw new Error("No current backend session for transcript delegation");
      }
      const status = await checkDelegationStatus(options.backendUrl, token, signal);
      alive();
      if (options.sessionStore.getToken() !== token || options.sessionStore.getAddress()?.toLowerCase() !== address) {
        throw new Error("Session changed during transcript delegation");
      }
      resolveTranscriptConsentStatus(address, status);
      observed = true;
      setServerDeliveryActive(deliveryEnabled(status));
      if (!serverDeliveryActive()) { cancel(key); return "disabled"; }
      const current = need(status, sessionExpiry);
      const repair = status.delivery === "schema_missing";
      if (!current.needed && !repair) { cancel(key); return "active"; }
      urgent = current.urgent || repair;
      const allowedAt = nextTranscriptAttempt(readBackoff(key), urgent);
      if (allowedAt > Date.now()) { schedule(key, allowedAt, options); return "busy"; }

      const schema = await ensureConnectorSchema(webConnectorPort(options.tcw));
      alive();
      if (!schema.ok) throw Object.assign(new Error("Connector schema unavailable"), { code: schema.code });
      if (current.needed) {
        const backendDid = await fetchServerInfoDid(options.backendUrl);
        alive();
        if (!backendDid?.startsWith("did:pkh:")) throw new Error("Backend DID unavailable");
        const session = options.tcw.session();
        if (!session?.siwe || !session.signature) throw new Error("TinyCloud session unavailable");
        const lifetime = Math.min(GRANT_LIFETIME, sessionExpiry - Date.now());
        if (lifetime <= 60_000) throw new Error("TinyCloud session expires too soon for delegation");
        const result = await options.tcw.delegateTo(backendDid, TRANSCRIPT_WRITER_PERMISSIONS, { expiry: lifetime });
        alive();
        if (result.prompted) throw new Error("Transcript delegation unexpectedly requested wallet approval");
        const portable = toPortableDelegation(result.delegation, address, options.tcw.chainId() ?? session.chainId, options.tcw.hosts[0] ?? "https://node.tinycloud.xyz");
        const serialized = await serializePortableDelegation(portable);
        alive();
        if (options.sessionStore.getToken() !== token || options.sessionStore.getAddress()?.toLowerCase() !== address) {
          throw new Error("Session changed during transcript delegation");
        }
        // A lost POST response can follow a successful store; disclose until status is known again.
        resolveTranscriptConsentStatus(address, null);
        const accepted = await sendDelegation(options.backendUrl, { serialized, siwe: session.siwe, signature: session.signature }, token, signal);
        alive();
        resolveTranscriptConsentStatus(address, accepted);
      }
      storage().removeItem(key);
      cancel(key);
      return "active";
    });
  } catch (error) {
    if (!observed) resolveTranscriptConsentStatus(address, null);
    recordFailure(key, options, urgent);
    console.warn("[transcript-delegation] silent renewal unavailable", warningCode(error));
    return "unavailable";
  }
}

function readLease(key: string): { owner: string; until: number } | null {
  const raw = storage().getItem(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "owner" in value && "until" in value
      && typeof value.owner === "string" && typeof value.until === "number") {
      return { owner: value.owner, until: value.until };
    }
  } catch { /* Corrupt leases are treated as expired. */ }
  return null;
}

async function attempt(options: Options, address: string, key: string, sessionExpiry: number): Promise<EnsureResult> {
  // Another tab holds the lock and may be minting right now: this tab's pre-lock "inactive" is
  // already stale, so disclose until a later status read observes the outcome.
  const anotherTabHolds = (): EnsureResult => {
    resolveTranscriptConsentStatus(address, null);
    schedule(key, Date.now() + 30_000, options);
    return "busy";
  };
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return anotherTabHolds();
      return underLock(options, address, key, sessionExpiry);
    });
  }
  const leaseKey = `tinychat.transcriptWriter.lease.${address}`;
  const owner = crypto.randomUUID();
  try {
    const previous = readLease(leaseKey);
    if (previous && previous.until > Date.now()) return anotherTabHolds();
    storage().setItem(leaseKey, JSON.stringify({ owner, until: Date.now() + LEASE_LIFETIME }));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (readLease(leaseKey)?.owner !== owner) return anotherTabHolds();
    try { return await underLock(options, address, key, sessionExpiry); }
    finally {
      if (readLease(leaseKey)?.owner === owner) storage().removeItem(leaseKey);
    }
  } catch (error) {
    console.warn("[transcript-delegation] lease unavailable", warningCode(error));
    recordFailure(key, options, true);
    return "unavailable";
  }
}

/** Headless session-key courier: never opens a wallet prompt, including on restore/focus. */
export async function ensureTranscriptWriterDelegation(options: Options): Promise<EnsureResult> {
  if (localValidationEnabled()) return "disabled";
  const address = options.tcw.address()?.toLowerCase();
  if (!address) return "unavailable";
  const key = `tinychat.transcriptWriter.${address}`;
  const ongoing = pending.get(key);
  if (ongoing) return ongoing;
  beginTranscriptConsentStatus(address);
  let observed = false;
  const run = (async (): Promise<EnsureResult> => {
    try {
      const session = options.tcw.session();
      const token = options.sessionStore.getToken();
      if (!session || !token || options.sessionStore.isExpired() || options.sessionStore.getAddress()?.toLowerCase() !== address) {
        throw new Error("No active matching session");
      }
      const sessionExpiry = sessionExpiration(session.siwe);
      const status = await withAttemptTimeout(async (alive, signal) => {
        const result = await checkDelegationStatus(options.backendUrl, token, signal);
        alive();
        return result;
      });
      if (options.sessionStore.getToken() !== token || options.sessionStore.getAddress()?.toLowerCase() !== address) {
        throw new Error("Session changed during transcript delegation");
      }
      resolveTranscriptConsentStatus(address, status);
      observed = true;
      setServerDeliveryActive(deliveryEnabled(status));
      if (!serverDeliveryActive()) { cancel(key); return "disabled"; }
      const current = need(status, sessionExpiry);
      const repair = status.delivery === "schema_missing";
      if (!current.needed && !repair) { cancel(key); return "active"; }
      const allowedAt = nextTranscriptAttempt(readBackoff(key), current.urgent || repair);
      if (allowedAt > Date.now()) { schedule(key, allowedAt, options); return "busy"; }
      return attempt(options, address, key, sessionExpiry);
    } catch (error) {
      if (!observed) resolveTranscriptConsentStatus(address, null);
      console.warn("[transcript-delegation] status unavailable", warningCode(error));
      recordFailure(key, options, true);
      return "unavailable";
    }
  })();
  pending.set(key, run);
  try { return await run; }
  finally { if (pending.get(key) === run) pending.delete(key); }
}
