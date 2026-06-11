import { DEFAULT_MODEL } from "./threadStore";
import { isTeeCapableModel } from "./completionStore";

/**
 * ST1 — the single sanitize choke point for persisted model ids.
 *
 * A pre-PR persisted model id (e.g. `openai/gpt-5-mini`) can re-enter selection
 * state from localStorage, the per-space SQL `active_model` setting, or a stored
 * thread row. None of those sources are validated against the phala-only
 * catalog, so a stale id survives and recurs every sign-in. Route every restore
 * through this pure helper so a non-offered id heals to a valid `fallback`.
 *
 * `offered` is the set of currently-offered model ids (from the loaded `/models`
 * list). BEFORE that list loads it is empty — in which case we fall back to the
 * `phala/` prefix gate (`isTeeCapableModel`) so a non-phala legacy id is still
 * rejected and the instant-paint path never renders a stale non-TEE model.
 *
 * Returns `model` when it is offered (or, pre-load, phala-prefixed); otherwise
 * `fallback`.
 */
export function sanitizeModel(
  model: string | null | undefined,
  offered: ReadonlySet<string> | readonly string[],
  fallback: string = DEFAULT_MODEL,
): string {
  if (!model) return fallback;
  const set = offered instanceof Set ? offered : new Set(offered);
  if (set.size > 0) {
    return set.has(model) ? model : fallback;
  }
  // Offered list not loaded yet — phala/ prefix gate keeps the first paint valid
  // while still rejecting a non-phala legacy id.
  return isTeeCapableModel(model) ? model : fallback;
}

/**
 * ST1 — the heal decision shared by every restore path (App SQL `active_model`
 * reconcile, runtime thread-model sync). `sanitizeModel` says what the picker
 * should show; this also reports whether the persisted SOURCE was stale and so
 * must be rewritten, so a corrected value does not recur on the next sign-in /
 * thread open. `healed` is true only when a non-null source value changed.
 *
 * Callers persist the correction (App: `pickModel` → SQL `active_model` +
 * localStorage; runtime: `setThreadModel`) iff `healed`.
 */
export interface ModelHealDecision {
  /** The offered model id the picker/UI should display. */
  model: string;
  /** True when `saved` was a stale value that was corrected (persist it back). */
  healed: boolean;
}

export function healPersistedModel(
  saved: string | null | undefined,
  offered: ReadonlySet<string> | readonly string[],
  fallback: string = DEFAULT_MODEL,
): ModelHealDecision {
  const model = sanitizeModel(saved, offered, fallback);
  return { model, healed: saved != null && saved !== "" && model !== saved };
}
