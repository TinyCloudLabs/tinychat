// The container half of the background-notifications surface, as a hook, so the
// Connectors card's section and the Meeting sources Manage panel run the same
// state machine (`backgroundSyncState.ts`) over the same drain lane. Everything
// the component used to hold lives here unchanged: the ref-mirrored state that
// publishes to the shared drain record, the load-on-mount read on the drain
// lane, and the dark-route report.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import { ingestQueuedMeetings } from "@/lib/connectors/targetedSync";
import {
  subscribeTranscriptConsent, transcriptConsentState, type TranscriptConsentState,
} from "@/lib/transcriptDeliveryState";
import type { ConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import {
  initialBackgroundSyncState,
  loadOnMount,
  refreshQueue,
  syncQueuedMeetings,
  type BackgroundSyncDeps,
  type BackgroundSyncEmit,
  type BackgroundSyncState,
} from "./backgroundSyncState";
import {
  enqueueDrainWork,
  publishBackgroundDrainConnectorState,
  readBackgroundDrainGeneration,
} from "./useBackgroundDrain";

export interface UseBackgroundSyncOptions {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /** FE0's typed client, built once by the card from backendUrl + sessionStore. */
  webhooks: ConnectorWebhooksClient;
  /** Fired after a processing run wrote meetings, so the row's count refreshes. */
  onIngested?: () => void;
  /**
   * The mount-time probe's verdict, reported up so the teardown can tell a dark
   * deployment from a 404 that means something else. Fired only once the probe
   * has actually answered — `loading` reports nothing.
   */
  onFeatureDark?: (dark: boolean) => void;
}

export interface BackgroundSyncController {
  state: BackgroundSyncState;
  deps: BackgroundSyncDeps;
  emit: BackgroundSyncEmit;
  /** TC-641: whether the off-state consent must also disclose the transcript-writer grant. */
  transcriptConsent: TranscriptConsentState;
  /** Processes the queue on the shared drain lane, then reports the ingest. */
  runSync: () => Promise<void>;
  /** Re-reads the queue (enabled) or the config (anything else). */
  retry: () => void;
}

export function useBackgroundSync({
  tcw,
  descriptor,
  webhooks,
  onIngested,
  onFeatureDark,
}: UseBackgroundSyncOptions): BackgroundSyncController {
  const [state, setState] = useState<BackgroundSyncState>(initialBackgroundSyncState);
  // React may keep this mounted state around after Connectors closes; an emit
  // into an unmounted tree is dropped rather than warned about.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A ref mirror of the emitted state, so every transition can be published to
  // the shared drain record — the headless drainer's counts and this surface's
  // counts are the same fact, and a sync here must not leave a stale count
  // elsewhere. The mirror is what makes that survive an unmount mid-run: the
  // publish happens BEFORE the alive check, so a user who starts a sync and
  // navigates away still gets the settled numbers into the store.
  const stateRef = useRef<BackgroundSyncState>(initialBackgroundSyncState());
  // The store generation this section instance belongs to, captured ONCE at
  // mount. Because the ref-mirror deliberately publishes past unmount, a run
  // still unwinding after sign-out cleared the record would otherwise
  // repopulate it with the previous account's counts — the store drops any
  // publish whose captured generation is stale.
  const [publishGeneration] = useState(readBackgroundDrainGeneration);
  const emit = useCallback(
    (updater: (prev: BackgroundSyncState) => BackgroundSyncState) => {
      const next = updater(stateRef.current);
      stateRef.current = next;
      // The numbers are already in hand after every run — no re-count, no HTTP.
      publishBackgroundDrainConnectorState(
        descriptor.source,
        next,
        !isSecretsUnlocked(tcw),
        publishGeneration,
      );
      if (!alive.current) return;
      setState(next);
    },
    [descriptor.source, tcw, publishGeneration],
  );

  const deps: BackgroundSyncDeps = useMemo(
    () => ({
      source: descriptor.source,
      webhooks,
      secrets: {
        isUnlocked: () => isSecretsUnlocked(tcw),
        // Reachable ONLY from the user-initiated sync action — never on mount.
        unlock: () => unlockSecrets<SecretsErr>(tcw),
      },
      ingest: (items) =>
        ingestQueuedMeetings({ tcw, descriptor, items, webhooks }),
    }),
    [tcw, descriptor, webhooks],
  );

  // On the shared drain lane: the app-shell headless drain may already be
  // mid-run when Connectors opens, and two concurrent drains could re-surface
  // and double-fetch the same meeting. Serializing changes WHEN this starts,
  // never what it does.
  useEffect(() => {
    void enqueueDrainWork(() => loadOnMount(deps, emit));
  }, [deps, emit]);

  // TC-641: whether the off-state consent must also disclose the transcript-writer grant.
  const transcriptConsent = useSyncExternalStore(
    subscribeTranscriptConsent, transcriptConsentState, transcriptConsentState,
  );

  // `loading` is "we have not asked yet" and says nothing either way; every
  // other phase is a probe that answered.
  useEffect(() => {
    if (state.phase === "loading") return;
    onFeatureDark?.(state.phase === "dark");
  }, [state.phase, onFeatureDark]);

  const runSync = useCallback(async () => {
    // Same lane as the headless drain — a click while it is in flight waits
    // its turn instead of racing it for the same queue.
    await enqueueDrainWork(() => syncQueuedMeetings(deps, emit));
    onIngested?.();
  }, [deps, emit, onIngested]);

  const retry = useCallback(() => {
    void (state.phase === "enabled"
      ? refreshQueue(deps, emit) // read-only — no drain, no lane needed
      : enqueueDrainWork(() => loadOnMount(deps, emit)));
  }, [deps, emit, state.phase]);

  return {
    state,
    deps,
    emit,
    transcriptConsent,
    runSync,
    retry,
  };
}
