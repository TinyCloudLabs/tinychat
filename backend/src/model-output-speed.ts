/**
 * Each agent chat provider call's output is capped to what its model streams in the turn time left, at the model's
 * normal speed (TC-4203). Turns that would run past the clock end at the cap, are charged, and keep their output. A turn
 * that still times out ran slower than normal, so the timeout is ours and is free.
 *
 * Source: OpenRouter's per-provider throughput on each model's page (https://openrouter.ai/<model id>), read
 * 2026-11-24 11:21Z. Each value is the median across the listed providers, rounded down; the comment gives the provider
 * count and range. RedPill's /models declares no throughput, and these numbers are not measurements of RedPill's
 * endpoints. Re-read them when a model is added, or replace them with RedPill measurements.
 */
const OUTPUT_TOKENS_PER_SECOND: Readonly<Record<string, number>> = {
  "moonshotai/kimi-k3": 60, // 27 providers, 19-171 tok/s
  "z-ai/glm-5.3": 87, // 47 providers, 13-170 tok/s
  "z-ai/glm-5.2": 74, // 28 providers, 40-243 tok/s
  "qwen/qwen3.6-35b-a3b": 22, // 10 providers, 16-144 tok/s
};

/** A model with no entry gets the slowest listed speed. */
const UNLISTED_OUTPUT_TOKENS_PER_SECOND = Math.min(...Object.values(OUTPUT_TOKENS_PER_SECOND));

/** The share of the time left that output may take. The rest covers time to first token, tool calls and delivery. */
const OUTPUT_TIME_SHARE = 0.8;

/** The most output tokens a call to `model` can stream in `remainingMs` at its normal speed, with the margin above. */
export function timeCappedOutputTokens(model: string, remainingMs: number): number {
  const perSecond = OUTPUT_TOKENS_PER_SECOND[model] ?? UNLISTED_OUTPUT_TOKENS_PER_SECOND;
  return Math.max(1, Math.floor(perSecond * (remainingMs / 1000) * OUTPUT_TIME_SHARE));
}
