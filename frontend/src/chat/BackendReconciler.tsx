// The app-shell mount point for W6 — the BROWSER RECONCILE (backend-ingest plan
// §8.1 W6). Headless: it renders nothing, gates nothing, and says nothing.
//
// WHY IT IS NOT PART OF THE MEETINGS VIEW. W5's read API is the surface a user
// sees, and its whole point is that it needs NO vault and NO key — so
// `MeetingsSection` deliberately holds no TinyCloud handle. The reconcile is the
// opposite: it exists only when a vault IS unlocked, and it writes the user's own
// space. Keeping it here, beside the Option-C drainer, is what lets both stay
// true at once.
//
// ONE LANE. The Option-C drain (`useBackgroundDrain` / the Settings surface) and
// this reconcile both write the user's single space, and TinyCloud drops
// concurrent responses on one space — so this run enters through the SAME
// serialized lane the drain uses (`enqueueDrainWork`). Nothing here reaches into
// that module's state; it only queues behind it. (For a cohort address `/drain`
// returns nothing anyway — plan §5.3 — so in practice the two never contend; the
// lane is what makes that a guarantee instead of a coincidence.)
//
// PACED, NEVER POLLED. One run per mount, plus a re-arm on the same unlock event
// the drain listens for, so a vault unlocked after sign-in still gets its copy.
// No timers. A run is cheap when there is nothing to do: the discovery filter is
// one metadata GET that comes back empty.
//
// QUIET AND SAFE. Failures are swallowed here — background work must never
// reject into the shell — and nothing is logged: a meeting id is an identifier
// and the content is the user's own words.

import { useEffect, useRef } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  reconcileBackendMeetings,
  type BackendReconcileMeetingsClient,
  type BackendReconcileSecrets,
} from "@/lib/connectors/backendReconcile";
import { onSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { createConnectorMeetingsClient } from "@/lib/connectors/meetingsApi";
import { DEFAULT_MEETINGS_SOURCE } from "@/lib/connectors/meetingsView";
import { enqueueDrainWork } from "./useBackgroundDrain";

export interface BackendReconcileMountOptions {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  backendUrl: string;
  source?: string;
  /** Injectable for tests; defaults to W5's typed client. */
  meetings?: BackendReconcileMeetingsClient;
  /** Injectable for tests; defaults to the real vault check (a read, never a prompt). */
  secrets?: BackendReconcileSecrets;
}

/**
 * One reconcile pass, serialized against the drain and swallowing everything.
 *
 * The outcome is deliberately dropped: W6 has no surface of its own, and the
 * meetings view already renders the server copy — which is the same meeting.
 */
export async function runBackendReconcile(
  options: BackendReconcileMountOptions,
): Promise<void> {
  const { tcw, sessionStore, backendUrl } = options;
  const meetings =
    options.meetings ??
    createConnectorMeetingsClient(backendUrl, { sessionStore });
  try {
    await enqueueDrainWork(() =>
      reconcileBackendMeetings({
        tcw,
        meetings,
        source: options.source ?? DEFAULT_MEETINGS_SOURCE,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      }),
    );
  } catch {
    // Nothing to do and nobody to tell: the next mount, or the next unlock,
    // retries, and the server still lists the row as unreconciled.
  }
}

/**
 * Fire-and-forget on mount, re-armed by an unlock. Registration is effect-time
 * (never module load) so a sign-out cleanly unhooks it, exactly as the drainer's
 * listener does.
 */
export function useBackendReconcile(options: BackendReconcileMountOptions): void {
  const { tcw, sessionStore, backendUrl, source, meetings, secrets } = options;
  // The latest options, read by the listener without re-registering it.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    void runBackendReconcile(latest.current);
    const off = onSecretsUnlocked(() => {
      void runBackendReconcile(latest.current);
    });
    return off;
    // Same dependency shape as the drainer: the shell's identities, not the ref.
  }, [tcw, sessionStore, backendUrl, source, meetings, secrets]);
}

/** Renders NOTHING, in every state. */
export function BackendReconciler(props: BackendReconcileMountOptions): null {
  useBackendReconcile(props);
  return null;
}
