/**
 * Hold enablement until both the account and its chosen model are explicitly admitted.
 *
 * `accountAllowed`/`modelAllowed` serve the eliza-service path and admit only what the lists name. The `mcp*`
 * variants serve MCP chat turns only: a `*` account entry admits every account on the MCP (the account list stays
 * the only way in, so an empty list admits nobody), and an empty model list admits every offered model.
 */
export function meetingRolloutFromEnv(env: Record<string, string | undefined>) {
  const accounts = new Set((env.MEETING_CONTENT_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  const models = new Set((env.MEETING_CONTENT_MODELS ?? "").split(",").map(value => value.trim()).filter(Boolean));
  return {
    enabled: env.MEETING_CONTENT_RETRIEVAL_ENABLED === "true",
    accountAllowed: (address: string) => accounts.has(address.toLowerCase()),
    modelAllowed: (model: string) => models.has(model),
    mcpAccountAllowed: (address: string) => accounts.has("*") || accounts.has(address.toLowerCase()),
    mcpModelAllowed: (model: string) => models.size === 0 || models.has(model),
  };
}
