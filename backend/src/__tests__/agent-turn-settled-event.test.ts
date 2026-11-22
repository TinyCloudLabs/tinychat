import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { createRequestContextMiddleware, recordAgentTurnSettled, type RequestEvent } from "../request-context.js";

// TC-3734: every settled agent chat turn ships one `agent_turn_settled` event with its real
// credit cost. It carries no ID, address, model or text.

function inScope(operation: () => void): RequestEvent[] {
  const events: RequestEvent[] = [];
  const req = Object.assign(new EventEmitter(), { method: "POST", get: () => undefined }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    headersSent: true,
    statusCode: 200,
    setHeader() { return this; },
    getHeader() { return undefined; },
  }) as unknown as Response;
  createRequestContextMiddleware(event => events.push(event))(req, res, operation);
  return events.filter(event => event.event === "agent_turn_settled");
}

describe("agent_turn_settled event", () => {
  test("emits exactly the declared fields inside a request scope", () => {
    const events = inScope(() => recordAgentTurnSettled({ rawCredits: 412, charged: 320, windowKind: "day", outcome: "limit_stop", startedAttempts: 3 }));
    expect(events).toEqual([{ event: "agent_turn_settled", raw_credits: 412, charged: 320, window_kind: "day", outcome: "limit_stop", started_attempts: 3 }]);
  });

  test("omits started_attempts when undefined or invalid", () => {
    const events = inScope(() => {
      recordAgentTurnSettled({ rawCredits: 0, charged: 0, windowKind: "week", outcome: "cancelled" });
      recordAgentTurnSettled({ rawCredits: 5, charged: 5, windowKind: "day", outcome: "success", startedAttempts: -1 });
      recordAgentTurnSettled({ rawCredits: 5, charged: 5, windowKind: "day", outcome: "success", startedAttempts: 1.5 });
    });
    expect(events).toEqual([
      { event: "agent_turn_settled", raw_credits: 0, charged: 0, window_kind: "week", outcome: "cancelled" },
      { event: "agent_turn_settled", raw_credits: 5, charged: 5, window_kind: "day", outcome: "success" },
      { event: "agent_turn_settled", raw_credits: 5, charged: 5, window_kind: "day", outcome: "success" },
    ]);
  });

  test("emits nothing outside a request scope", () => {
    const writes: unknown[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      expect(() => recordAgentTurnSettled({ rawCredits: 10, charged: 10, windowKind: "day", outcome: "success" })).not.toThrow();
    } finally {
      process.stdout.write = original;
    }
    expect(writes).toEqual([]);
  });

  test("skips the event when raw_credits or charged is not a non-negative integer", () => {
    const events = inScope(() => {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        recordAgentTurnSettled({ rawCredits: bad, charged: 1, windowKind: "day", outcome: "failed" });
        recordAgentTurnSettled({ rawCredits: 1, charged: bad, windowKind: "day", outcome: "failed" });
      }
    });
    expect(events).toEqual([]);
  });
});
