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
      const fail = (message: string) => setError({ id: d.id, message });
      try {
        if (!secretsAvailable()) return fail(SECRETS_UNAVAILABLE_IN_APP_MESSAGE);
        if (!isSecretsUnlocked(tcw)) {
          const unlock = await unlockSecrets<SecretsErr>(tcw);
          if (!unlock.ok) return fail(unlock.error?.message ?? "Could not unlock secrets");
        }
        const key = await getConnectorKey<SecretsErr>(tcw, d);
        if (!key.ok) {
          return fail(
            key.error?.message ??
              (d.id === "google-meet"
                ? "Could not read the saved Google connection"
                : "Could not read API key"),
          );
        }
        const controller = new AbortController();
        const outcome =
          d.id === "google-meet"
            ? await runGmeetSyncNow({
                tcw,
                backendUrl,
                sessionStore,
                refreshToken: key.data,
                signal: controller.signal,
                onProgress: () => {},
              })
            : await runFirefliesSyncNow({
                tcw,
                apiKey: key.data,
                signal: controller.signal,
                onProgress: () => {},
              });
        if (!outcome.ok) fail(outcome.message);
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
