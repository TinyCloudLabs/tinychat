import { expect, test } from "bun:test";
import { botsFromEnv } from "../routes/bots";

const enabled = { BOTS_ENABLED: "true", BOTS_SERVICE_URL: "http://bots.test", BOTS_SERVICE_SECRET: "test-only", BOTS_TEST_ACCOUNTS: "*" };

test("the default proxy allows the five-minute bot turn plus transport margin", () => {
  expect(botsFromEnv(enabled)!.postTimeoutMs).toBe(360_000);
});

test("a stale two-minute proxy override cannot truncate a five-minute bot turn", () => {
  expect(botsFromEnv({ ...enabled, BOTS_POST_TIMEOUT_MS: "120000" })!.postTimeoutMs).toBe(360_000);
});

test("the proxy follows a longer configured bot turn and preserves a larger explicit proxy budget", () => {
  expect(botsFromEnv({ ...enabled, BOTS_TURN_TIMEOUT_MS: "600000" })!.postTimeoutMs).toBe(660_000);
  expect(botsFromEnv({ ...enabled, BOTS_POST_TIMEOUT_MS: "900000" })!.postTimeoutMs).toBe(900_000);
});

test("invalid and timer-overflow settings fall back to a usable budget", () => {
  for (const value of ["-1", "NaN", "Infinity", "0", "2147483648"]) {
    expect(botsFromEnv({ ...enabled, BOTS_TURN_TIMEOUT_MS: value, BOTS_POST_TIMEOUT_MS: value })!.postTimeoutMs).toBe(360_000);
  }
});
