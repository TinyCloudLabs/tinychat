export const GRANOLA_SECRET_NAME = "GRANOLA_API_KEY";

// Build-time opt-in for Granola connection setup and sync.

/** Exact-match "true", the same contract the backend's *_ENABLED flags use. */
export function granolaConnectorEnabled(
  env: Record<string, unknown> = readViteEnv(),
): boolean {
  return env.VITE_GRANOLA_CONNECTOR_ENABLED === "true";
}

function readViteEnv(): Record<string, unknown> {
  try {
    return (import.meta.env ?? {}) as Record<string, unknown>;
  } catch {
    // No Vite env injection in this runtime (bun unit tests) — flag is off.
    return {};
  }
}
