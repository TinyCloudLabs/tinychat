// Granola connector arming flag (granola plan S3). A build-time Vite env,
// default off: the registry row renders coming-soon and the sync dispatch
// never runs for it. Set VITE_GRANOLA_CONNECTOR_ENABLED=true to arm.

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
