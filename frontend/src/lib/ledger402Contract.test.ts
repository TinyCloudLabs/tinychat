import { afterEach, describe, expect, test } from "bun:test";

import { streamAgentChat, onAgentPaywallError } from "./agentChatApi.js";
import { PaywallError, onPaywallError, streamChat } from "./chatApi.js";
import { isPaywallActionable } from "./paywall.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

type Ledger402Body = {
  error: "credit_budget_exceeded";
  message: string;
  tier: "free" | "plus" | "pro";
  source: string;
  usage?: { used: number; limit: number; resetsAt: string };
};

function paywallResponse(body: Ledger402Body): Response {
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

async function parseChat402(body: Ledger402Body): Promise<PaywallError> {
  globalThis.fetch = (async () => paywallResponse(body)) as typeof fetch;
  const emitted: unknown[] = [];
  const unsubscribe = onPaywallError((payload) => emitted.push(payload));
  try {
    const stream = streamChat({
      backendUrl: "http://backend.test",
      sessionStore,
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    let thrown: unknown;
    try {
      await stream.next();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaywallError);
    expect(emitted).toEqual([body]);
    return thrown as PaywallError;
  } finally {
    unsubscribe();
  }
}

async function parseAgentChat402(body: Ledger402Body): Promise<PaywallError> {
  globalThis.fetch = (async () => paywallResponse(body)) as typeof fetch;
  const emitted: unknown[] = [];
  const unsubscribe = onAgentPaywallError((payload) => emitted.push(payload));
  try {
    const stream = streamAgentChat({
      backendUrl: "http://backend.test",
      getToken: () => "token",
      messages: [{ role: "user", content: "hi" }],
    });
    let thrown: unknown;
    try {
      await stream.next();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaywallError);
    expect(emitted).toEqual([body]);
    return thrown as PaywallError;
  } finally {
    unsubscribe();
  }
}

describe("ledger 402 frontend contract", () => {
  test("config_outage source is ignored and a missing usage still routes both chat paths", async () => {
    const configOutage = {
      error: "credit_budget_exceeded",
      message: "Credit budget cannot be determined until billing configuration is repaired.",
      tier: "pro",
      source: "config_outage",
    } satisfies Ledger402Body;

    const chatError = await parseChat402(configOutage);
    const agentError = await parseAgentChat402(configOutage);

    for (const error of [chatError, agentError]) {
      expect(error.payload).toEqual(configOutage);
      expect(Object.hasOwn(error.payload, "usage")).toBe(false);
      expect(isPaywallActionable(error.payload)).toBe(true);
    }
  });

  test("a 402 with usage remains distinguishable from the config_outage shape", async () => {
    const withUsage = {
      error: "credit_budget_exceeded",
      message: "Credit budget exhausted for the Pro tier.",
      tier: "pro",
      source: "ledger",
      usage: { used: 28_000, limit: 28_000, resetsAt: "2026-07-17T00:00:00.000Z" },
    } satisfies Ledger402Body;

    const chatError = await parseChat402(withUsage);
    const agentError = await parseAgentChat402(withUsage);

    for (const error of [chatError, agentError]) {
      expect(error.payload).toEqual(withUsage);
      expect(Object.hasOwn(error.payload, "usage")).toBe(true);
      expect(error.payload.usage).toEqual(withUsage.usage);
      expect(isPaywallActionable(error.payload)).toBe(true);
    }
  });
});
