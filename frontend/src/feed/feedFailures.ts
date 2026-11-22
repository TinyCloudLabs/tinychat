/**
 * What kind of failure a Feed request had, kept so a failed answer can be traced to its cause. The Feed's database
 * calls report errors with fixed text ("SQL operation failed"), and the SDK folds a thrown error into a generic
 * SQL_ERROR, so the cause is read where the call is made: the error code and the HTTP status, or the phone session's
 * own fixed messages. Never the message text of an error, which may carry card content or addresses.
 *
 * The last failures are kept on this device (localStorage) for support to read.
 */

const KEY = "tinychat:feed-failures:v1";
const KEEP = 20;

export interface FeedFailure {
  /** ISO time. */
  at: string;
  /** "read" and "write" are single database calls; "answer" is the failed send of an answer or an owner action. */
  op: "read" | "write" | "answer";
  /** The error code, with the HTTP status after a slash when the node gave one: "SQL_ERROR/401". */
  kind: string;
}

/** The phone session guard's own messages (openkeyNativeRenewal.ts), the only message text that is read. */
const SESSION_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  ["OpenKey session is signed out", "SESSION_SIGNED_OUT"],
  ["OpenKey renewal is temporarily unavailable", "SESSION_RENEWAL_UNAVAILABLE"],
  ["TinyCloud session changed during the request. Please try again.", "SESSION_CHANGED"],
];

const CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const NAME = /^[A-Za-z]{1,30}$/;

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}

function statusOf(error: unknown): number | undefined {
  const direct = field(error, "status");
  const status = typeof direct === "number" ? direct : field(field(error, "meta"), "status");
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

/** A short fixed-vocabulary name for a thrown error or a failed result's error. */
export function failureKind(error: unknown): string {
  if (error instanceof Error) {
    const known = SESSION_MESSAGES.find(([message]) => message === error.message);
    if (known) return known[1];
  }
  const code = field(error, "code");
  const status = statusOf(error);
  if (typeof code === "string" && CODE.test(code)) return status === undefined ? code : `${code}/${status}`;
  if (status !== undefined) return `HTTP/${status}`;
  const name = error instanceof Error ? error.name : undefined;
  return name && NAME.test(name) ? `THROWN_${name}` : "THROWN";
}

let memory: FeedFailure[] = [];

function load(): FeedFailure[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is FeedFailure => typeof field(entry, "kind") === "string" && typeof field(entry, "at") === "string") : [];
  } catch { return []; }
}

export function recordFeedFailure(op: FeedFailure["op"], kind: string): void {
  const entry: FeedFailure = { at: new Date().toISOString(), op, kind };
  memory = [...(memory.length ? memory : load()), entry].slice(-KEEP);
  try { window.localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* the log is best effort */ }
  if (op === "answer") console.warn("[feed] answer not sent", { kind });
}

/** The kept failures, oldest first. */
export function recentFeedFailures(): FeedFailure[] {
  return memory.length ? [...memory] : load();
}

/**
 * A failed answer send. The SDK reports every failure of the send as one generic code, so the kind is the latest
 * failed database call since the send began, and only without one the thrown error's own kind.
 */
export function recordAnswerFailure(error: unknown, since: number): void {
  const cause = recentFeedFailures().reverse().find((failure) => failure.op !== "answer" && Date.parse(failure.at) >= since);
  recordFeedFailure("answer", cause?.kind ?? failureKind(error));
}

/** Tests only. */
export function resetFeedFailuresForTests(): void {
  memory = [];
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Records every failed call of a Feed database: a thrown error, or a result with `ok: false`. The call's own
 * outcome is returned or rethrown unchanged.
 */
export function observeFeedFailures<T extends object>(database: T): T {
  return new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "query" && property !== "execute" && property !== "batch") return value.bind(target);
      const op = property === "query" ? "read" as const : "write" as const;
      return async (...args: unknown[]) => {
        try {
          const result = await Reflect.apply(value, target, args) as { ok?: boolean; error?: unknown } | undefined;
          if (result && result.ok === false) recordFeedFailure(op, failureKind(result.error));
          return result;
        } catch (error) {
          recordFeedFailure(op, failureKind(error));
          throw error;
        }
      };
    },
  });
}
