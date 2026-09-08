/**
 * The ordered set of models Tinychat offers for new conversations.
 *
 * Eligibility and context budgeting are product configuration, not catalog or
 * pricing data. Keep this list static so clients can safely select before the
 * pricing endpoint has loaded (or when it is unavailable).
 */
export const OFFERED_CHAT_MODELS = [
  { id: "moonshotai/kimi-k3", contextTokens: 1_048_576 },
  { id: "z-ai/glm-5.3", contextTokens: 1_048_576 },
  { id: "z-ai/glm-5.2", contextTokens: 1_048_576 },
  { id: "qwen/qwen3.6-35b-a3b", contextTokens: 262_144 },
] as const;

export type OfferedModelId = (typeof OFFERED_CHAT_MODELS)[number]["id"];

export const DEFAULT_CHAT_MODEL: OfferedModelId = OFFERED_CHAT_MODELS[0].id;

const OFFERED_CHAT_MODEL_IDS: ReadonlySet<string> = new Set(
  OFFERED_CHAT_MODELS.map(({ id }) => id),
);

export function isOfferedChatModel(model: string): model is OfferedModelId {
  return OFFERED_CHAT_MODEL_IDS.has(model);
}

export function offeredChatModelContextTokens(model: string): number | undefined {
  return OFFERED_CHAT_MODELS.find(({ id }) => id === model)?.contextTokens;
}
