// "Disconnect <source>" for the Meeting sources window: the same ordered
// teardown `ConnectorDisconnectDialog` runs (`runDisconnect`, with an upstream
// revoke first for Google), driven from a hook so the designed confirmation can
// own the presentation. The design's copy is "Meetings already in your space
// stay", so this is the keep-data plan only; deleting synced meetings stays on
// the flag-off Connectors page.
//
// Success is `progress.done` and nothing else. A partial teardown leaves the
// connector connected, keeps the sheet open, and offers the runner's retry.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useCallback, useRef, useState } from "react";

import {
  NO_DELIVERY_LANE,
  WEBHOOKLESS_STEPS,
  googleDisconnectStatusMessage,
  revokeGoogleUpstream,
  upstreamRevokeMessage,
  usesOAuthConnect,
  type UpstreamRevokeState,
} from "@/chat/ConnectorDialog";
import { removeBackgroundDrainConnectorRecord } from "@/chat/useBackgroundDrain";
import { deleteConnectorCredentials } from "@/lib/connectors/namedConnectorSecrets";
import { usesNamedConnectorKeys } from "@/lib/connectors/connectorKeyMode";
import { isSecretsUnlocked, unlockSecrets, type SecretsErr } from "@/lib/connectors/connectorSecrets";
import {
  type DisconnectMode,
  disconnectRetry,
  disconnectStatusMessage,
  initialDisconnectProgress,
  runDisconnect,
  type DisconnectDeps,
  type DisconnectProgress,
  type DisconnectWebhooks,
} from "@/lib/connectors/connectorLifecycle";
import * as connectorStore from "@/lib/connectors/connectorStore";
import type { ConnectorDescriptor } from "@/lib/connectors/types";

export interface ConnectorDisconnectController {
  running: boolean;
  /** The runner's own success signal; a revoke warning can still be showing. */
  done: boolean;
  /** The retry the runner offers after a partial teardown, if any. */
  retryLabel: string | null;
  /** A failure or revoke warning to show on the sheet. */
  error: string | null;
  /** A run that stopped part-way pins its plan: resuming under the other one would skip steps by name. */
  planLocked: boolean;
  run: (mode: DisconnectMode) => Promise<void>;
  reset: () => void;
}

export function useConnectorDisconnect(input: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  webhooks: DisconnectWebhooks;
  backendUrl: string;
  sessionStore: SessionStore;
  /** From the Background-sync probe: the companion router is established to be unmounted. */
  featureDark: boolean;
  /** A sync this window started is still running: its final write would resurrect the connection. */
  blocked?: boolean;
  onDisconnected: () => void;
  runner?: typeof runDisconnect;
}): ConnectorDisconnectController {
  const {
    tcw,
    descriptor,
    webhooks,
    backendUrl,
    sessionStore,
    featureDark,
    blocked = false,
    onDisconnected,
    runner = runDisconnect,
  } = input;
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DisconnectProgress | null>(null);
  const [revoke, setRevoke] = useState<UpstreamRevokeState | null>(null);
  // Read by the retry in the same tick the failing run wrote it.
  const progressRef = useRef<DisconnectProgress | null>(null);
  const oauth = usesOAuthConnect(descriptor);

  const reset = useCallback(() => {
    setRunning(false);
    setProgress(null);
    setRevoke(null);
    progressRef.current = null;
  }, []);

  const run = useCallback(async (chosen: DisconnectMode) => {
    if (blocked) return;
    setRunning(true);
    const resume = progressRef.current;
    if (oauth && resume === null) {
      const outcome = await revokeGoogleUpstream({ tcw, descriptor, backendUrl, sessionStore });
      setRevoke(outcome);
      if (outcome.status === "locked" || outcome.status === "server-unavailable") {
        // Nothing has happened yet: the honest state is "not disconnected, try again".
        setRunning(false);
        return;
      }
    }
    const namedKeyStorage = usesNamedConnectorKeys();
    const deps: DisconnectDeps = {
      connectorId: descriptor.id,
      source: descriptor.source,
      mode: resume?.mode ?? chosen,
      webhooks: oauth ? NO_DELIVERY_LANE : webhooks,
      featureDark,
      secrets: {
        isUnlocked: () => namedKeyStorage || isSecretsUnlocked(tcw),
        unlock: () => namedKeyStorage ? Promise.resolve({ ok: true }) : unlockSecrets<SecretsErr>(tcw),
        deleteKey: () => deleteConnectorCredentials(tcw, descriptor),
      },
      store: {
        listKnownSourceIds: () => connectorStore.listKnownSourceIds(tcw, descriptor.source),
        purgeConnector: () => connectorStore.purgeConnector(tcw, descriptor.source),
        clearFirefliesAttempt: () =>
          descriptor.id === "fireflies"
            ? connectorStore.clearFirefliesAttempt(tcw)
            : Promise.resolve({ ok: true, data: undefined }),
        getConnection: () => connectorStore.getConnection(tcw, descriptor.id),
        countMeetings: () => connectorStore.countMeetings(tcw, descriptor.source),
        updateSyncState: (update) => connectorStore.updateSyncState(tcw, update),
      },
    };
    const from =
      resume ??
      (oauth
        ? { ...initialDisconnectProgress(deps.mode), completed: [...WEBHOOKLESS_STEPS] }
        : undefined);
    const final = await runner(
      deps,
      (updater) => setProgress((prev) => updater(prev ?? initialDisconnectProgress(deps.mode))),
      from,
    );
    progressRef.current = final;
    setRunning(false);
    if (!final.done) return;
    removeBackgroundDrainConnectorRecord(descriptor.source);
    onDisconnected();
  }, [backendUrl, blocked, descriptor, featureDark, oauth, onDisconnected, runner, sessionStore, tcw, webhooks]);

  const retry = progress ? disconnectRetry(progress) : null;
  const failureMessage = progress?.failure
    ? oauth
      ? googleDisconnectStatusMessage(progress)
      : disconnectStatusMessage(progress)
    : null;
  const revokeWarning =
    revoke && revoke.status !== "revoked" ? upstreamRevokeMessage(revoke) : null;

  return {
    running,
    done: progress?.done === true,
    retryLabel: retry?.label ?? null,
    planLocked: progress !== null,
    error: failureMessage ?? revokeWarning,
    run,
    reset,
  };
}
