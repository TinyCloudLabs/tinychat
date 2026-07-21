import { describe, expect, test } from "bun:test";
import { evaluateLedgerGate } from "../ledger-gate.js";
import { TIERS } from "../tiers.js";

function evaluate(overrides: Partial<Parameters<typeof evaluateLedgerGate>[0]> = {}) {
  let localFallbackCalls = 0;
  const result = evaluateLedgerGate({
    tier: TIERS.free,
    anchor: null,
    entitlement: {
      credit_limit: 500,
      committed_credits: 0,
      period_anchor: "utc_day",
      isOutage: false,
    },
    outagePolicy: "bounded_k",
    isLocalOverBudget: () => {
      localFallbackCalls++;
      return false;
    },
    ...overrides,
  });
  return { result, localFallbackCalls };
}

describe("evaluateLedgerGate", () => {
  test("sidecar anchored_week plus local day routes through outage fallback, never the healthy compare", () => {
    const { result, localFallbackCalls } = evaluate({
      entitlement: {
        credit_limit: 1,
        committed_credits: 100,
        period_anchor: "anchored_week",
        isOutage: false,
      },
    });

    expect(result).toEqual({
      deny: false,
      includeUsage: true,
      reason: "outage",
      source: "authority_mismatch",
    });
    expect(localFallbackCalls).toBe(1);
  });

  test("local weekly tier with a null anchor is a hard outage without a local window fallback", () => {
    const { result, localFallbackCalls } = evaluate({
      tier: TIERS.plus,
      anchor: null,
      entitlement: undefined,
      outagePolicy: "fail_closed",
    });

    expect(result).toEqual({
      deny: true,
      includeUsage: false,
      reason: "outage",
      source: "config_outage",
    });
    expect(localFallbackCalls).toBe(0);
  });

  test("clean zero credit limit is a configuration outage, not a healthy 402", () => {
    const { result, localFallbackCalls } = evaluate({
      entitlement: {
        credit_limit: 0,
        committed_credits: 0,
        period_anchor: "utc_day",
        isOutage: false,
      },
    });

    expect(result).toEqual({
      deny: false,
      includeUsage: true,
      reason: "outage",
      source: "config_outage",
    });
    expect(localFallbackCalls).toBe(1);
  });

  test("matching authorities retain the committed-at-limit 402", () => {
    const { result, localFallbackCalls } = evaluate({
      entitlement: {
        credit_limit: 500,
        committed_credits: 500,
        period_anchor: "utc_day",
        isOutage: false,
      },
    });

    expect(result).toEqual({
      deny: true,
      includeUsage: true,
      reason: "ledger_limit",
      source: "ledger",
    });
    expect(localFallbackCalls).toBe(0);
  });

  test("a null committed count is an outage even if an unsafe caller marks the response healthy", () => {
    const { result, localFallbackCalls } = evaluate({
      entitlement: {
        credit_limit: 500,
        committed_credits: null,
        period_anchor: "utc_day",
        isOutage: false,
      },
    });

    expect(result).toEqual({
      deny: false,
      includeUsage: true,
      reason: "outage",
      source: "outage_policy",
    });
    expect(localFallbackCalls).toBe(1);
  });
});
