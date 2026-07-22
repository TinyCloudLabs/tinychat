import { describe, expect, test } from "bun:test";

import type { BillingConfig } from "./billingApi";
import {
  DEFAULT_RETRY_BACKOFF_MS,
  MAX_INITIAL_ATTEMPTS,
  fetchConfigWithRetry,
  shouldRefetch,
  usageChipAffordance,
  type BillingConfigState,
  type RefetchTrigger,
} from "./billingConfigPolicy";

const CONFIG: BillingConfig = {
  paywallEnabled: true,
  tiers: [],
  accountAppUrl: "https://account.example",
};

/** A sleep spy that never actually waits — records the requested delays. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe("A1 fetchConfigWithRetry — bounded, backed-off, stops on success", () => {
  test("returns the first success and STOPS retrying (no extra attempts, no sleeps)", async () => {
    let calls = 0;
    const { delays, sleep } = fakeSleep();
    const result = await fetchConfigWithRetry(
      () => {
        calls++;
        return Promise.resolve(CONFIG);
      },
      { sleep },
    );
    expect(result).toBe(CONFIG);
    expect(calls).toBe(1); // stopped after the first success
    expect(delays).toEqual([]); // no backoff on the happy path
  });

  test("retries a transient failure, then returns the eventual success", async () => {
    let calls = 0;
    const { delays, sleep } = fakeSleep();
    const result = await fetchConfigWithRetry(
      () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("429"));
        return Promise.resolve(CONFIG);
      },
      { sleep },
    );
    expect(result).toBe(CONFIG);
    expect(calls).toBe(2); // one failure, one success — then it stops
    expect(delays).toEqual([DEFAULT_RETRY_BACKOFF_MS[0]]); // one backoff before the retry
  });

  test("is bounded: at most MAX_INITIAL_ATTEMPTS calls, then resolves null", async () => {
    let calls = 0;
    const { delays, sleep } = fakeSleep();
    const result = await fetchConfigWithRetry(
      () => {
        calls++;
        return Promise.reject(new Error("down"));
      },
      { sleep },
    );
    expect(result).toBeNull(); // never throws; gives up with null
    expect(calls).toBe(MAX_INITIAL_ATTEMPTS); // hard cap = 3
    expect(calls).toBeLessThanOrEqual(MAX_INITIAL_ATTEMPTS);
    // Backoff applied before attempts 2 and 3 only (bounded, escalating).
    expect(delays).toEqual([DEFAULT_RETRY_BACKOFF_MS[0], DEFAULT_RETRY_BACKOFF_MS[1]]);
  });

  test("honors an injected attempt cap (never exceeds it)", async () => {
    let calls = 0;
    const { sleep } = fakeSleep();
    const result = await fetchConfigWithRetry(
      () => {
        calls++;
        return Promise.reject(new Error("down"));
      },
      { sleep, maxAttempts: 1 },
    );
    expect(result).toBeNull();
    expect(calls).toBe(1); // a trigger refetch is a single attempt
  });
});

describe("A1 shouldRefetch — re-fetch only while null; never re-fetch a held config", () => {
  const held: BillingConfigState = { config: CONFIG, initialFetchFailed: false };
  const nullFresh: BillingConfigState = { config: null, initialFetchFailed: false };
  const nullFailed: BillingConfigState = { config: null, initialFetchFailed: true };
  const allTriggers: RefetchTrigger[] = ["settings-entry", "paywall-402", "window-focus"];

  test("a held (non-null) config is NEVER re-fetched on ANY trigger (incl. focus)", () => {
    for (const trigger of allTriggers) {
      expect(shouldRefetch(held, trigger)).toBe(false);
    }
    // Even after a prior failure, once a config is held focus must not refetch.
    expect(shouldRefetch({ config: CONFIG, initialFetchFailed: true }, "window-focus")).toBe(false);
  });

  test("settings-entry refetches when config is null", () => {
    expect(shouldRefetch(nullFresh, "settings-entry")).toBe(true);
    expect(shouldRefetch(nullFailed, "settings-entry")).toBe(true);
  });

  test("paywall-402 refetches when config is null", () => {
    expect(shouldRefetch(nullFresh, "paywall-402")).toBe(true);
    expect(shouldRefetch(nullFailed, "paywall-402")).toBe(true);
  });

  test("window-focus refetches ONLY after the initial fetch failed", () => {
    expect(shouldRefetch(nullFresh, "window-focus")).toBe(false); // initial fetch still in flight
    expect(shouldRefetch(nullFailed, "window-focus")).toBe(true); // initial fetch exhausted → recover
  });
});

describe("A1/A2 no-nag — paid tier sees no new upgrade CTA", () => {
  test("the usage chip is a plain meter for every tier (no tier branch)", () => {
    // The invariant: A1/A2 add NO tier-conditional nag. pro === free === null.
    expect(usageChipAffordance("pro")).toBe("usage-meter");
    expect(usageChipAffordance("free")).toBe("usage-meter");
    expect(usageChipAffordance(null)).toBe("usage-meter");
    expect(usageChipAffordance("pro")).toBe(usageChipAffordance("free"));
  });
});
