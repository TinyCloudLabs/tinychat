// The container half of the background-notifications surface, as a hook, so the
// Connectors card's section and the Meeting sources Manage panel run the same
// state machine (`backgroundSyncState.ts`) over the same drain lane. Everything
// the component used to hold lives here unchanged: the ref-mirrored state that
// publishes to the shared drain record, the load-on-mount read on the drain
// lane, the fail-closed consent probe and the dark-route report.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import { ingestQueuedMeetings } from "@/lib/connectors/targetedSync";
import type { ConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import type { ConnectorMeetingsClient } from "@/lib/connectors/meetingsApi";
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

/** The only two texts an off state may render — A and B never ship (consentCopy.ts). */
export type OffStateConsentVariant = "C" | "B-ingest";

/**
 * F011's whole decision, as a pure function so the fail-closed matrix is
 * directly unit-testable: ONLY an affirmative `"ok"` from the cohort-gated
 * meetings list selects the B-ingest copy. `feature-dark` (the not-in-cohort
 * 404), `unauthenticated`, `offline`, `retryable`, `rejected`, a missing
 * result — every one of them is Option C. The parameter is deliberately loose
 * (`{ status: string }`) so no widening of the client's result union can ever
 * make an unconsidered status affirmative.
 */
export function consentVariantForProbe(
  result: { status: string } | null | undefined,
): OffStateConsentVariant {
  return result?.status === "ok" ? "B-ingest" : "C";
}

export interface UseBackgroundSyncOptions {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /** FE0's typed client, built once by the card from backendUrl + sessionStore. */
  webhooks: ConnectorWebhooksClient;
  /**
   * F011: the cohort-gated READ client. Optional ON PURPOSE — an absent client
   * is just one more non-affirmative answer, so the off state fails closed to
   * Option C instead of failing open to the cohort text.
   */
  meetings?: ConnectorMeetingsClient;
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
  consentVariant: OffStateConsentVariant;
  ingestConsentChecked: boolean;
  setIngestConsentChecked: (checked: boolean) => void;
  /** Processes the queue on the shared drain lane, then reports the ingest. */
  runSync: () => Promise<void>;
  /** Re-reads the queue (enabled) or the config (anything else). */
  retry: () => void;
}

export function useBackgroundSync({
  tcw,
  descriptor,
  webhooks,
  meetings,
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

  // F011 — which consent text an off state shows, plus the B-ingest
  // attestation's checked state. Both start C-safe: the variant is Option C
  // until proven otherwise, and the attestation starts unchecked.
  const [consentVariant, setConsentVariant] = useState<OffStateConsentVariant>("C");
  const [ingestConsentChecked, setIngestConsentChecked] = useState(false);

  // The cohort probe — deliberately its OWN effect, NOT a rider on the drain
  // lane above: it is a read of a different API (the cohort-gated meetings
  // list), and queueing it behind a drain run would delay the consent decision
  // for no custody reason. It asks once per mount (the card's useMemo keeps
  // `meetings` stable) and only an affirmative "ok" ever selects B-ingest —
  // see `consentVariantForProbe` for the full fail-closed matrix. Accepted
  // transient: until the probe answers, a cohort user's off state briefly
  // shows Option C, because fail-closed reads "no affirmative signal yet" as
  // C; the probe starts at mount alongside loadOnMount's own /config
  // round-trip, so it typically settles in the same network beat.
  useEffect(() => {
    // Re-arm the fail-closed default whenever the probe's inputs change.
    setConsentVariant("C");
    if (!meetings) return;
    let cancelled = false;
    (async () => {
      try {
        const probe = await meetings.list({ source: descriptor.source, limit: 1 });
        if (cancelled) return;
        setConsentVariant(consentVariantForProbe(probe));
      } catch {
        // `list()` resolves for every HTTP state — a throw is a programmer
        // error, and a failed probe is no affirmative signal: stay on C.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetings, descriptor.source]);

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
    consentVariant,
    ingestConsentChecked,
    setIngestConsentChecked,
    runSync,
    retry,
  };
}
