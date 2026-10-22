import type { AgentTaskUsage } from "../agent-task-client.js";
import { creditsFor, type ModelRates } from "./credits.js";

/**
 * How an in-progress agent turn reacts once its accrued credits reach the
 * credits remaining in the account's budget. `finish_answer` lets exactly one
 * more provider round run after the limit is first seen, then stops.
 */
export type BudgetStopMode = "finish_answer" | "hard_stop" | "predict_next_round" | "off";
/** `log` records a below-minimum turn and admits it; `enforce` refuses it with 402. */
export type BudgetPreflightMode = "log" | "enforce" | "off";

/**
 * Minimum credits a turn must be able to spend before it is admitted.
 * Placeholder ceiling for a short turn at fallback rates; to be refined from measured turns.
 */
export const MIN_TURN_CREDITS = 320;

const STOP_MODES: readonly BudgetStopMode[] = ["finish_answer", "hard_stop", "predict_next_round", "off"];
const PREFLIGHT_MODES: readonly BudgetPreflightMode[] = ["log", "enforce", "off"];

export function parseBudgetStopMode(raw: string | undefined): BudgetStopMode {
  if (raw === undefined || raw === "") return "finish_answer";
  if ((STOP_MODES as readonly string[]).includes(raw)) return raw as BudgetStopMode;
  console.warn(`[agent-chat] invalid AGENT_CHAT_BUDGET_STOP_MODE=${raw}; using finish_answer`);
  return "finish_answer";
}

export function parseBudgetPreflightMode(raw: string | undefined): BudgetPreflightMode {
  if (raw === undefined || raw === "") return "log";
  if ((PREFLIGHT_MODES as readonly string[]).includes(raw)) return raw as BudgetPreflightMode;
  console.warn(`[agent-chat] invalid AGENT_CHAT_BUDGET_PREFLIGHT=${raw}; using log`);
  return "log";
}

/**
 * Returns a usage observer for one task turn. It is driven only by usage
 * checkpoints that begin a provider round (`startedAttempts` increased). It
 * returns "budget_exhausted" at most once, when the turn should stop.
 */
export function createTurnBudgetMonitor(options: {
  mode: Exclude<BudgetStopMode, "off">;
  remaining: number;
  rates: ModelRates;
}): (usage: AgentTaskUsage) => "budget_exhausted" | undefined {
  const { mode, remaining, rates } = options;
  let previousStarted = 0;
  let accruedAtPreviousStart = 0;
  let lastRoundCost = 0;
  let crossedAtRound: number | null = null;
  let stopped = false;

  const stop = (accrued: number, round: number) => {
    stopped = true;
    console.info("[agent-chat] turn budget", { event: "stop", mode, accrued, remaining, round });
    return "budget_exhausted" as const;
  };

  return (usage) => {
    if (stopped || usage.startedAttempts <= previousStarted) return undefined;
    previousStarted = usage.startedAttempts;
    const accrued = creditsFor(rates, usage.promptTokens, usage.completionTokens);
    lastRoundCost = accrued - accruedAtPreviousStart;
    accruedAtPreviousStart = accrued;
    const round = usage.startedAttempts;
    const over = mode === "predict_next_round" ? accrued + lastRoundCost >= remaining : accrued >= remaining;

    if (crossedAtRound === null) {
      if (!over) return undefined;
      crossedAtRound = round;
      console.info("[agent-chat] turn budget", { event: "crossed", mode, accrued, remaining, round });
      // finish_answer lets this round run; the next start checkpoint stops the turn.
      if (mode === "finish_answer") return undefined;
      return stop(accrued, round);
    }
    // Only finish_answer reaches here: the limit was crossed at an earlier start checkpoint.
    return stop(accrued, round);
  };
}
