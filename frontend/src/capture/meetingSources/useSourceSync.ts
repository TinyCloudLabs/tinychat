// "Sync now" for the Meeting sources window: the same two engines the
// Connectors card runs (`runFirefliesSyncNow`, `runGmeetSyncNow`), the same
// sequence in front of them — secrets available, vault unlocked, the registry
// row's secret read — and the same reload of the connection afterwards, which
// is the source of truth for the count and the "synced" time.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useCallback, useRef, useState } from "react";

import { runFirefliesSyncNow, runGmeetSyncNow } from "@/chat/ConnectorsCard";
import {
  getConnectorKey,
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import type { ConnectorDescriptor, ConnectorId } from "@/lib/connectors/types";
import { SECRETS_UNAVAILABLE_IN_APP_MESSAGE, secretsAvailable } from "@/lib/openkeyNative";

export const SOURCE_SYNC_FAILED_MESSAGE = "Sync failed. Try again.";

type SyncEngineInput = { tcw: TinyCloudWeb; signal: AbortSignal; onProgress: () => void };
type SyncOutcome = { ok: true } | { ok: false; message: string };

export interface SourceSyncDeps {
  secretsAvailable: () => boolean;
  isSecretsUnlocked: (tcw: TinyCloudWeb) => boolean;
  unlockSecrets: typeof unlockSecrets;
  getConnectorKey: typeof getConnectorKey;
  runGmeetSyncNow: (
    input: SyncEngineInput & {
      backendUrl: string;
      sessionStore: SessionStore;
      refreshToken: string;
    },
  ) => Promise<SyncOutcome>;
  runFirefliesSyncNow: (input: SyncEngineInput & { apiKey: string }) => Promise<SyncOutcome>;
}

const DEFAULT_DEPS: SourceSyncDeps = {
  secretsAvailable,
  isSecretsUnlocked,
  unlockSecrets,
  getConnectorKey,
  runGmeetSyncNow,
  runFirefliesSyncNow,
};

/** One sync attempt. Resolves to the message to show on the row, or null when it worked. Never rejects. */
export async function runSourceSync(
  d: ConnectorDescriptor,
  input: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore },
  deps: SourceSyncDeps = DEFAULT_DEPS,
): Promise<string | null> {
  const { tcw, backendUrl, sessionStore } = input;
  try {
    if (!deps.secretsAvailable()) return SECRETS_UNAVAILABLE_IN_APP_MESSAGE;
    if (!deps.isSecretsUnlocked(tcw)) {
      const unlock = await deps.unlockSecrets<SecretsErr>(tcw);
      if (!unlock.ok) return unlock.error?.message ?? "Could not unlock secrets";
    }
    const key = await deps.getConnectorKey<SecretsErr>(tcw, d);
    if (!key.ok) {
      return (
        key.error?.message ??
        (d.id === "google-meet"
          ? "Could not read the saved Google connection"
          : "Could not read API key")
      );
    }
    const controller = new AbortController();
    const outcome =
      d.id === "google-meet"
        ? await deps.runGmeetSyncNow({
            tcw,
            backendUrl,
            sessionStore,
            refreshToken: key.data,
            signal: controller.signal,
            onProgress: () => {},
          })
        : await deps.runFirefliesSyncNow({
            tcw,
            apiKey: key.data,
            signal: controller.signal,
            onProgress: () => {},
          });
    return outcome.ok ? null : outcome.message;
  } catch (cause) {
    console.error(`Meeting source sync failed for ${d.id}`, cause);
    return SOURCE_SYNC_FAILED_MESSAGE;
  }
}

export interface SourceSyncController {
  /** The connector currently syncing, if any. */
  syncingId: ConnectorId | null;
  error: { id: ConnectorId; message: string } | null;
  sync: (descriptor: ConnectorDescriptor) => Promise<void>;
}

export function useSourceSync(input: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** Called after every attempt with the reloaded connection's id. */
  onSettled: (id: ConnectorId) => void;
}): SourceSyncController {
  const { tcw, backendUrl, sessionStore, onSettled } = input;
  const [syncingId, setSyncingId] = useState<ConnectorId | null>(null);
  const [error, setError] = useState<SourceSyncController["error"]>(null);
  const inFlight = useRef(false);

  const sync = useCallback(
    async (d: ConnectorDescriptor) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSyncingId(d.id);
      setError(null);
      try {
        const message = await runSourceSync(d, { tcw, backendUrl, sessionStore });
        if (message) setError({ id: d.id, message });
      } finally {
        inFlight.current = false;
        setSyncingId(null);
        onSettled(d.id);
      }
    },
    [tcw, backendUrl, sessionStore, onSettled],
  );

  return { syncingId, error, sync };
}
