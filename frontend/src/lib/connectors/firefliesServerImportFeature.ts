// Opt-in flag for reading Fireflies server-imported KV-only records in Library.
// OFF by default until the release go-ahead after per-secret keys (TC-3284) and terminal grants (TC-3810) are live.

export interface FirefliesServerImportCapabilities {
  firefliesServerImport?: boolean;
}

/** Exact-match "true" on Vite env or explicit backend server-info capability. */
export function firefliesServerImportEnabled(
  env: Record<string, unknown> = readViteEnv(),
  capabilities?: FirefliesServerImportCapabilities | null,
): boolean {
  return (
    env.VITE_FIREFLIES_SERVER_IMPORT_ENABLED === "true" ||
    capabilities?.firefliesServerImport === true
  );
}

function readViteEnv(): Record<string, unknown> {
  try {
    return (import.meta.env ?? {}) as Record<string, unknown>;
  } catch {
    // No Vite env injection in this runtime (bun unit tests) — flag is off.
    return {};
  }
}
