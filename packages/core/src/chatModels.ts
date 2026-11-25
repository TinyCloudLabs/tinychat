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

/**
 * Models the app calls for background work but never offers for conversations.
 *
 * They stay out of the picker and out of GET /api/chat/models. The backend
 * admits them on POST /api/chat only, and only for a request that sets both an
 * output cap and a reasoning preference.
 */
export const BACKGROUND_CHAT_MODELS = [
  { id: "moonshotai/kimi-k3.1-pro", contextTokens: 1_048_576 },
] as const;

export type BackgroundModelId = (typeof BACKGROUND_CHAT_MODELS)[number]["id"];

// No module-level Set here: a bundler cannot drop one it cannot prove unused, and the frontend never calls this.
export function isBackgroundChatModel(model: string): model is BackgroundModelId {
  return BACKGROUND_CHAT_MODELS.some(({ id }) => id === model);
}
