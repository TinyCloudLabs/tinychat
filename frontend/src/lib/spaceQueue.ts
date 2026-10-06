// One queue per TinyCloud space for the reads and writes that share a screen
// (TC-761): the Library's reads and an upload's storage calls. TinyCloud drops
// concurrent responses on one space, so they take turns.
//
// Scheduling is leaf-level: every single storage call (`tcw.kv.*`, or a
// `tcw.sql.db(name).*` call) is one task, and no task ever schedules another,
// so the queue cannot deadlock. A long upload (one stored part per task)
// interleaves with Library reads instead of making them wait for the whole
// file. The drain, reconciler, Google Meet and library-sync lanes keep their
// own lane (useBackgroundDrain's), and voice-note saves are not queued.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const tails = new Map<string, Promise<void>>();
const settle = () => undefined;

/** Runs `task` after every task already queued for `spaceKey`, first in first out. A rejection never blocks the queue. */
export function runOnSpace<T>(spaceKey: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(spaceKey) ?? Promise.resolve();
  const run = previous.then(() => task());
  const tail = run.then(settle, settle);
  tails.set(spaceKey, tail);
  void tail.then(() => {
    if (tails.get(spaceKey) === tail) tails.delete(spaceKey);
  });
  return run;
}

type AnyFn = (...args: unknown[]) => unknown;

/** The services' synchronous members (lifecycle hooks, `kv.withPrefix`): they run in place, never queued. */
const SYNCHRONOUS = new Set<PropertyKey>(["initialize", "onSessionChange", "onSignOut", "withPrefix"]);

/**
 * `service` with each method call made one queued task. `returns` wraps what a
 * synchronous member gives back instead (`sql.db(name)` returns a handle whose
 * own calls are queued). Data properties pass through.
 */
function queueCalls<T extends object>(service: T, spaceKey: string, returns: Partial<Record<PropertyKey, (value: unknown) => unknown>> = {}): T {
  return new Proxy(service, {
    get(object, key) {
      const value = Reflect.get(object, key, object) as unknown;
      if (typeof value !== "function") return value;
      const method = value as AnyFn;
      const wrap = returns[key as keyof typeof returns];
      if (wrap) return (...args: unknown[]) => wrap(method.apply(object, args));
      if (SYNCHRONOUS.has(key)) return method.bind(object);
      return (...args: unknown[]) => runOnSpace(spaceKey, async () => method.apply(object, args));
    },
  });
}

const scheduled = new WeakMap<TinyCloudWeb, TinyCloudWeb>();

/**
 * `tcw` with its storage calls queued per space: each `tcw.kv.*` call and each
 * `tcw.sql.db(name).*` call is one task. Everything else (did, secrets, the
 * session) passes through untouched. Cached per tcw, so the same session always
 * gets the same handle (stable for React dependencies).
 */
export function scheduledSpace(tcw: TinyCloudWeb): TinyCloudWeb {
  const cached = scheduled.get(tcw);
  if (cached) return cached;
  const spaceKey = tcw.spaceId ?? tcw.did;
  const services = new WeakMap<object, object>();
  const queuedService = (key: PropertyKey, service: object): object => {
    let wrapped = services.get(service);
    if (!wrapped) {
      wrapped =
        key === "sql"
          ? queueCalls(service, spaceKey, {
              db: (handle) => (handle !== null && typeof handle === "object" ? queueCalls(handle, spaceKey) : handle),
            })
          : queueCalls(service, spaceKey);
      services.set(service, wrapped);
    }
    return wrapped;
  };
  const proxy = new Proxy(tcw, {
    get(object, key) {
      const value = Reflect.get(object, key, object) as unknown;
      if ((key === "kv" || key === "sql") && value !== null && typeof value === "object") return queuedService(key, value);
      // Methods run on the real client, so private fields and `this` still work.
      return typeof value === "function" ? (value as AnyFn).bind(object) : value;
    },
  });
  scheduled.set(tcw, proxy);
  return proxy;
}
