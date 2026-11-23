// Switch for saving a connector key under its own encryption key (a "v2" secret; TC-3284).
// OFF by default: a v2 secret is refused by readers that cannot open it yet (older CLI profiles, the roci board, OpenKey
// and the bots), so it is turned on only when every reader is ready. The read grants for these keys are not behind this
// switch. ON when the build sets `VITE_CONNECTOR_NAMED_KEY_WRITES` to exactly "true", or when this browser has set the
// runtime flag below to exactly "true" (the way to try it on a live build without shipping a new one).

export const NAMED_KEY_WRITES_RUNTIME_FLAG_KEY = "tinychat:connectors:named-key-writes";

export function connectorNamedKeyWritesEnabled(
  env: Record<string, unknown> = readViteEnv(),
  storage: Pick<Storage, "getItem"> | null = readStorage(),
): boolean {
  if (env.VITE_CONNECTOR_NAMED_KEY_WRITES === "true") return true;
  try {
    return storage?.getItem(NAMED_KEY_WRITES_RUNTIME_FLAG_KEY) === "true";
  } catch {
    // Storage blocked: the switch stays off.
    return false;
  }
}

function readViteEnv(): Record<string, unknown> {
  try {
    return (import.meta.env ?? {}) as Record<string, unknown>;
  } catch {
    // No Vite env injection in this runtime (bun unit tests): the build flag is off.
    return {};
  }
}

function readStorage(): Pick<Storage, "getItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
