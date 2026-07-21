// ── Memory extraction model selection (pure, testable) ───────────────
//
// Memory extraction must POST an OFFERED model id or the node 403s with
// `model_not_offered` and memory silently never updates. The model lineup has
// churned repeatedly (gpt-5-mini → gpt-oss-20b → qwen-2.5-7b → deepseek-v4-pro
// → deepseek-v3.2 → deepseek-v4-flash),
// so a hardcoded preferred id can drift out of the catalog. This pure helper
// picks a model guaranteed to be offered (when the catalog is loaded) and
// reports WHY, so the caller can warn on drift without baking I/O into the
// decision. runtime.tsx wraps this with the console.warn side effect.

export type ExtractionModelSource =
  /** Catalog not loaded yet — returned the preferred id as a best effort. */
  | "catalog-empty"
  /** Preferred id is offered — the happy path. */
  | "preferred"
  /** Preferred not offered; fell back to the current chat model (definitionally offered). */
  | "chat"
  /** Preferred and chat model both unusable; fell back to the first offered id. */
  | "first";

export interface ExtractionModelChoice {
  model: string;
  source: ExtractionModelSource;
}

/**
 * Pure: choose an extraction model that is offered (when the catalog is
 * loaded). Preference order: preferred → current chat model → first offered.
 *
 * Invariant: when `offered` is non-empty, the returned `model` is always a
 * member of `offered` (so the extraction POST can never 403 on an unoffered
 * id). When `offered` is empty/absent the catalog simply hasn't loaded yet, so
 * the preferred id is returned as a best effort (`source: "catalog-empty"`).
 */
export function pickExtractionModel(
  preferred: string,
  offered: ReadonlySet<string> | null | undefined,
  chatModel: string | null | undefined,
): ExtractionModelChoice {
  if (!offered || offered.size === 0) return { model: preferred, source: "catalog-empty" };
  if (offered.has(preferred)) return { model: preferred, source: "preferred" };
  if (chatModel && offered.has(chatModel)) return { model: chatModel, source: "chat" };
  const first = offered.values().next().value as string | undefined;
  // first is always defined here (offered.size > 0), but guard for type safety.
  return first ? { model: first, source: "first" } : { model: preferred, source: "catalog-empty" };
}
