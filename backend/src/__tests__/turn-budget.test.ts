import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentTaskUsage } from "../agent-task-client.js";
import { creditsFor, type ModelRates } from "../billing/credits.js";
import { createTurnBudgetMonitor, parseBudgetPreflightMode, parseBudgetStopMode } from "../billing/turn-budget.js";

const rates: ModelRates = { creditsPerKInput: 200, creditsPerKOutput: 1000, fallback: true };
const cost = (prompt: number, completion: number) => creditsFor(rates, prompt, completion);
// A usage checkpoint that begins provider round `round`: the round has started, the previous one is finalized.
const start = (round: number, prompt = 0, completion = 0): AgentTaskUsage => ({
  promptTokens: prompt, completionTokens: completion, startedAttempts: round, reportedAttempts: round - 1, finalizedAttempts: round - 1, usageCompleteness: "partial",
});
// A usage frame that does not begin a round: the same round is still in flight, tokens grew.
const midRound = (round: number, prompt: number, completion: number): AgentTaskUsage => ({ ...start(round, prompt, completion) });

let info: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;
beforeEach(() => { info = spyOn(console, "info").mockImplementation(() => {}); warn = spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { info.mockRestore(); warn.mockRestore(); });

function drive(mode: "hard_stop" | "predict_next_round" | "finish_answer", remaining: number, usages: AgentTaskUsage[]) {
  const monitor = createTurnBudgetMonitor({ mode, remaining, rates });
  return usages.map(usage => monitor(usage));
}

describe("turn budget monitor", () => {
  test("hard_stop stops at the start checkpoint where accrued equals remaining", () => {
    const remaining = cost(1000, 0);
    expect(drive("hard_stop", remaining, [start(1), start(2, 1000, 0)])).toEqual([undefined, "budget_exhausted"]);
  });

  test("hard_stop keeps running while accrued stays one credit under remaining", () => {
    const remaining = cost(1000, 0) + 1;
    expect(drive("hard_stop", remaining, [start(1), start(2, 1000, 0)])).toEqual([undefined, undefined]);
  });

  test("finish_answer lets the crossing round run and stops at the next start checkpoint", () => {
    const remaining = cost(1000, 0);
    expect(drive("finish_answer", remaining, [start(1), start(2, 1000, 0), start(3, 2000, 0), start(4, 3000, 0)]))
      .toEqual([undefined, undefined, "budget_exhausted", undefined]);
  });

  test("finish_answer does not stop a turn that ends during the crossing round", () => {
    const remaining = cost(1000, 0);
    expect(drive("finish_answer", remaining, [start(1), start(2, 1000, 0)])).toEqual([undefined, undefined]);
  });

  test("usage frames that do not begin a round never count toward the budget", () => {
    const remaining = cost(1000, 0);
    // The mid-round frame reports the crossing tokens for round 1; it must not trigger a stop by itself.
    expect(drive("hard_stop", remaining, [start(1), midRound(1, 1000, 0), start(2, 1000, 0)])).toEqual([undefined, undefined, "budget_exhausted"]);
  });

  test("predict_next_round stops when accrued plus the last round's cost reaches remaining", () => {
    const perRound = cost(1000, 0);
    const remaining = perRound * 2;
    expect(drive("predict_next_round", remaining, [start(1), start(2, 1000, 0)])).toEqual([undefined, "budget_exhausted"]);
    expect(drive("hard_stop", remaining, [start(1), start(2, 1000, 0)])).toEqual([undefined, undefined]);
  });

  test("zero-token checkpoints never cross while remaining is positive", () => {
    expect(drive("hard_stop", 1, [start(1), start(2), start(3)])).toEqual([undefined, undefined, undefined]);
  });

  test("logs one crossed event and one stop event", () => {
    drive("finish_answer", cost(1000, 0), [start(1), start(2, 1000, 0), start(3, 2000, 0)]);
    const events = info.mock.calls.map(call => call[1]?.event);
    expect(events).toEqual(["crossed", "stop"]);
  });
});

describe("turn budget config parsing", () => {
  test("stop mode defaults to finish_answer when unset or empty", () => {
    expect(parseBudgetStopMode(undefined)).toBe("finish_answer");
    expect(parseBudgetStopMode("")).toBe("finish_answer");
  });

  test("stop mode accepts each documented value", () => {
    expect(parseBudgetStopMode("hard_stop")).toBe("hard_stop");
    expect(parseBudgetStopMode("predict_next_round")).toBe("predict_next_round");
    expect(parseBudgetStopMode("off")).toBe("off");
    expect(warn).not.toHaveBeenCalled();
  });

  test("an invalid stop mode warns and falls back to finish_answer", () => {
    expect(parseBudgetStopMode("bogus")).toBe("finish_answer");
    expect(warn.mock.calls[0]?.[0]).toContain("AGENT_CHAT_BUDGET_STOP_MODE");
  });

  test("preflight defaults to log and rejects unknown values with a warning", () => {
    expect(parseBudgetPreflightMode(undefined)).toBe("log");
    expect(parseBudgetPreflightMode("enforce")).toBe("enforce");
    expect(parseBudgetPreflightMode("nope")).toBe("log");
    expect(warn.mock.calls[0]?.[0]).toContain("AGENT_CHAT_BUDGET_PREFLIGHT");
  });

  test("empty budget settings are unset: defaults apply without any warning", () => {
    expect(parseBudgetStopMode("")).toBe("finish_answer");
    expect(parseBudgetPreflightMode("")).toBe("log");
    expect(warn).not.toHaveBeenCalled();
  });
});
