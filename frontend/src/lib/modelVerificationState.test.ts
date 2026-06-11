import { describe, expect, test } from "bun:test";

import {
  isForcedProbe,
  isRetryableStatus,
  shouldCacheVerdict,
} from "./modelVerificationState";

describe("ST6 — transient negative verdicts are not cached", () => {
  test("only a positive (enclave-verified) verdict is cached for the session", () => {
    expect(shouldCacheVerdict("verified")).toBe(true);
    // A network blip / provider hiccup must NOT stick — leaving the cache empty
    // means a subsequent select or reverify() re-probes instead of serving the
    // stale negative forever.
    expect(shouldCacheVerdict("error")).toBe(false);
    expect(shouldCacheVerdict("unverified")).toBe(false);
  });

  test("the header pill is retryable exactly in the negative states", () => {
    expect(isRetryableStatus("error")).toBe(true);
    expect(isRetryableStatus("unverified")).toBe(true);
    // verified expands (not "retry"); idle/verifying/unverifiable are not actions.
    expect(isRetryableStatus("verified")).toBe(false);
    expect(isRetryableStatus("verifying")).toBe(false);
    expect(isRetryableStatus("unverifiable")).toBe(false);
    expect(isRetryableStatus("idle")).toBe(false);
  });
});

describe("ST10 — the force-reverify token is one-shot", () => {
  const A = "phala/model-a";
  const B = "phala/model-b";

  test("one reverify() forces exactly one fresh probe for the targeted model", () => {
    // reverify() arms force={A,1}; no token consumed yet → forced.
    expect(isForcedProbe({ model: A, n: 1 }, null, A)).toBe(true);
  });

  test("after the forced probe consumes the token, A→B→A does NOT re-probe", () => {
    const force = { model: A, n: 1 };
    const consumed = { model: A, n: 1 };
    // Switching away to B: B is never forced by A's token.
    expect(isForcedProbe(force, consumed, B)).toBe(false);
    // Switching back to A: the token is already consumed → cache hit, no re-probe.
    expect(isForcedProbe(force, consumed, A)).toBe(false);
  });

  test("a second reverify() (bumped counter) re-arms a fresh probe", () => {
    // The prior token {A,1} is consumed, but reverify() bumps to {A,2}.
    expect(isForcedProbe({ model: A, n: 2 }, { model: A, n: 1 }, A)).toBe(true);
  });

  test("no force token at all → never a forced probe (normal cached path)", () => {
    expect(isForcedProbe(null, null, A)).toBe(false);
  });
});
