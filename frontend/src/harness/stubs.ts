// Stand-ins for the signed-in session, for real surfaces rendered without a
// backend: a signed-in account with an empty space. TinyCloud calls answer as
// the SDK does for nothing stored, and the harness server answers /api/* with
// fixtures or 404, which leaves each card in its signed-in-but-empty state.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

export const HARNESS_ADDRESS = "0x00000000000000000000000000000000000000a1";
export const HARNESS_DID = `did:pkh:eip155:1:${HARNESS_ADDRESS}`;

/** What an SDK call on `tcw.<service>` resolves to in an empty space. */
function emptySpace(service: string): unknown {
  const missing = (code: string) => ({ ok: false, error: { code, message: "harness: nothing stored" } });
  if (service === "sql") return { ok: true, data: { rows: [] } }; // tables exist and are empty
  if (service === "kv") return missing("KV_NOT_FOUND");
  if (service === "secrets") return missing("KEY_NOT_FOUND");
  return missing("NOT_FOUND");
}

// Any SDK member, at any depth, is callable (`tcw.sql.db(name).query(...)`)
// and awaitable; awaiting it gives the service's empty-space answer.
const sdkStub = (service: string): unknown =>
  new Proxy(function stub() {}, {
    get: (_target, key) => {
      const settled = Promise.resolve(emptySpace(service));
      if (key === "then") return settled.then.bind(settled);
      if (key === "catch") return settled.catch.bind(settled);
      if (key === "finally") return settled.finally.bind(settled);
      return sdkStub(service);
    },
    apply: () => sdkStub(service),
  });

export const harnessTcw = new Proxy(
  { did: HARNESS_DID, address: () => HARNESS_ADDRESS },
  {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : key === "then" ? undefined : sdkStub(String(key)),
  },
) as unknown as TinyCloudWeb;

export const harnessSessionStore = {
  getToken: () => "harness-token",
  isExpired: () => false,
  hasSession: () => true,
  clear: () => {},
} as unknown as SessionStore;

/** The harness clock: 2026-10-06 09:41 local time, so relative dates and timers render the same on every run. */
export const FROZEN_NOW = new Date(2026, 9, 6, 9, 41, 0).getTime();

/** Pins Date.now() and `new Date()` to FROZEN_NOW (?freeze=1). */
export function freezeClock(now: number = FROZEN_NOW): void {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now);
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
}
