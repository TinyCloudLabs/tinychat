import { describe, expect, test } from "bun:test";
import {
  agentStreamPolicyFromEnv,
  validateAgentStreamPolicy,
  type AgentStreamPolicy,
} from "../agent-stream-policy.js";

const fields = {
  heartbeatMs: "AGENT_STREAM_HEARTBEAT_MS",
  turnTimeoutMs: "AGENT_STREAM_TURN_TIMEOUT_MS",
  drainGraceMs: "AGENT_STREAM_DRAIN_GRACE_MS",
} as const;
const policy: AgentStreamPolicy = { heartbeatMs: 17, turnTimeoutMs: 251, drainGraceMs: 31 };
const env = Object.fromEntries(Object.entries(fields).map(([field, setting]) => [setting, String(policy[field as keyof AgentStreamPolicy])]));

describe("agent stream policy validation", () => {
  for (const [field, setting] of Object.entries(fields)) {
    for (const value of [undefined, null, "17", NaN, Infinity, -Infinity, 0, -1, 1.1, 2_147_483_648]) {
      test(`rejects invalid injected ${field} (${String(value)}) with only a setting name`, () => {
        expect(() => validateAgentStreamPolicy({ ...policy, [field]: value } as AgentStreamPolicy))
          .toThrow(`Invalid agent stream configuration: ${setting}`);
      });
    }
    for (const value of [undefined, "", "  ", " 17", "17 ", "17\n", "\n17", "NaN", "Infinity", "-1", "0", "1.5", "1e3", "0x10", "17ms", "2147483648", "synthetic-private-sentinel\n31"]) {
      test(`rejects invalid environment ${setting} (${JSON.stringify(value)})`, () => {
        let caught: unknown;
        try {
          agentStreamPolicyFromEnv({ ...env, [setting]: value }, true);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe(`Invalid agent stream configuration: ${setting}`);
      });
    }
  }

  test("returns valid injected policy unchanged", () => {
    expect(validateAgentStreamPolicy(policy)).toBe(policy);
    expect(agentStreamPolicyFromEnv(env, true)).toEqual(policy);
  });

  test("accepts both supported scheduler boundaries", () => {
    expect(validateAgentStreamPolicy({ heartbeatMs: 1, turnTimeoutMs: 2_147_483_647, drainGraceMs: 1 }))
      .toEqual({ heartbeatMs: 1, turnTimeoutMs: 2_147_483_647, drainGraceMs: 1 });
  });

  test("does not require or validate unused settings while agent chat is disabled", () => {
    expect(agentStreamPolicyFromEnv({}, false)).toBeUndefined();
    expect(agentStreamPolicyFromEnv({ AGENT_STREAM_HEARTBEAT_MS: "invalid-unused" }, false)).toBeUndefined();
  });

  test("rejects absent injected policy with a fixed name-only error", () => {
    expect(() => validateAgentStreamPolicy(undefined as unknown as AgentStreamPolicy))
      .toThrow("Invalid agent stream configuration: AGENT_STREAM_HEARTBEAT_MS");
  });
});
