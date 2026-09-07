import { DEFAULT_CHAT_MODEL, isOfferedChatModel } from "@tinyboilerplate/core";

/** Validate saved thread IDs against static eligibility, independently of pricing. */
export function sanitizeModel(
  model: string | null | undefined,
  _offered?: ReadonlySet<string> | readonly string[],
  fallback: string = DEFAULT_CHAT_MODEL,
): string {
  if (!model) return fallback;
  return isOfferedChatModel(model) ? model : fallback;
}

/** Report whether a nonempty historical ID needs a persisted correction. */
export interface ModelHealDecision {
  /** The offered model id the picker/UI should display. */
  model: string;
  /** True when `saved` was a stale value that was corrected (persist it back). */
  healed: boolean;
}

export function healPersistedModel(
  saved: string | null | undefined,
  offered?: ReadonlySet<string> | readonly string[],
  fallback: string = DEFAULT_CHAT_MODEL,
): ModelHealDecision {
  const model = sanitizeModel(saved, offered, fallback);
  return { model, healed: saved != null && saved !== "" && model !== saved };
}
