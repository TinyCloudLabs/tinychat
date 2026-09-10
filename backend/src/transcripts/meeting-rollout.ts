/** Hold enablement until both the account and its chosen model are explicitly admitted. */
export function meetingRolloutFromEnv(env: Record<string, string | undefined>) {
  const accounts = new Set((env.MEETING_CONTENT_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  const models = new Set((env.MEETING_CONTENT_MODELS ?? "").split(",").map(value => value.trim()).filter(Boolean));
  return {
    enabled: env.MEETING_CONTENT_RETRIEVAL_ENABLED === "true",
    accountAllowed: (address: string) => accounts.has(address.toLowerCase()),
    modelAllowed: (model: string) => models.has(model),
  };
}
