export interface AgentStreamPolicy {
  heartbeatMs: number;
  turnTimeoutMs: number;
  drainGraceMs: number;
}

const SETTINGS = {
  heartbeatMs: "AGENT_STREAM_HEARTBEAT_MS",
  turnTimeoutMs: "AGENT_STREAM_TURN_TIMEOUT_MS",
  drainGraceMs: "AGENT_STREAM_DRAIN_GRACE_MS",
} as const;
const MAX_TIMER_MS = 2_147_483_647;

function invalidSetting(setting: string): Error {
  return new Error(`Invalid agent stream configuration: ${setting}`);
}

export function validateAgentStreamPolicy(policy: AgentStreamPolicy): AgentStreamPolicy {
  for (const field of Object.keys(SETTINGS) as Array<keyof AgentStreamPolicy>) {
    const value = policy?.[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
      throw invalidSetting(SETTINGS[field]);
    }
  }
  return policy;
}

export function agentStreamPolicyFromEnv(
  env: Record<string, string | undefined>,
  agentChatEnabled: boolean,
): AgentStreamPolicy | undefined {
  if (!agentChatEnabled) return undefined;
  const read = (setting: string): number => {
    const value = env[setting];
    // Require a single decimal value: whitespace/newlines would change env-file forwarding.
    if (!value || /[^0-9]/.test(value)) throw invalidSetting(setting);
    return Number(value);
  };
  return validateAgentStreamPolicy({
    heartbeatMs: read(SETTINGS.heartbeatMs),
    turnTimeoutMs: read(SETTINGS.turnTimeoutMs),
    drainGraceMs: read(SETTINGS.drainGraceMs),
  });
}
