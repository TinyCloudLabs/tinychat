import { describe, expect, spyOn, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { CONNECTORS } from "@/lib/connectors/registry";
import { SOURCE_SYNC_FAILED_MESSAGE, runSourceSync, type SourceSyncDeps } from "./useSourceSync";

const fireflies = CONNECTORS.find((d) => d.id === "fireflies") as ConnectorDescriptor;
const input = { tcw: {} as TinyCloudWeb, backendUrl: "https://x.test", sessionStore: {} as SessionStore };

function deps(patch: Partial<SourceSyncDeps> = {}): SourceSyncDeps {
  return {
    secretsAvailable: () => true,
    isSecretsUnlocked: () => true,
    unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
    getConnectorKey: (async () => ({ ok: true, data: "key" })) as SourceSyncDeps["getConnectorKey"],
    runGmeetSyncNow: async () => ({ ok: true }),
    runFirefliesSyncNow: async () => ({ ok: true }),
    ...patch,
  };
}

describe("runSourceSync", () => {
  test("a clean sync resolves to no message", async () => {
    expect(await runSourceSync(fireflies, input, deps())).toBeNull();
  });

  test("an engine's own failure message is shown as is", async () => {
    const message = await runSourceSync(
      fireflies,
      input,
      deps({ runFirefliesSyncNow: async () => ({ ok: false, message: "Rate limited" }) }),
    );
    expect(message).toBe("Rate limited");
  });

  test("a rejecting engine becomes a row error instead of an unhandled rejection", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = await runSourceSync(
        fireflies,
        input,
        deps({
          runFirefliesSyncNow: async () => {
            throw new Error("boom");
          },
        }),
      );
      expect(message).toBe(SOURCE_SYNC_FAILED_MESSAGE);
      expect(SOURCE_SYNC_FAILED_MESSAGE).toBe("Sync failed. Try again.");
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("a rejecting vault read is also a row error", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = await runSourceSync(
        fireflies,
        input,
        deps({
          getConnectorKey: async () => {
            throw new Error("vault down");
          },
        }),
      );
      expect(message).toBe(SOURCE_SYNC_FAILED_MESSAGE);
    } finally {
      error.mockRestore();
    }
  });
});
