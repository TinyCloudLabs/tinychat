// The Settings surface for background notifications.
//
// It sits INSIDE the Fireflies connector row and is deliberately a separate,
// optional thing from "Fireflies connected": the connector works without it,
// and turning it on is a second, explicit choice. Nothing here is a new visual
// system — same SectionCard/Button/muted-text language as the rest of Settings.
//
// The component decides nothing. `backgroundSyncState.ts` owns every rule
// (dark route, one-time reveal, "Enabled in TinyChat" and never "Live",
// blocked ≠ empty, no unlock on mount); `BackgroundSyncView` renders exactly
// what that state says and hands user intent back through props. That is what
// makes the product rules testable in a workspace with no DOM harness.
//
// CUSTODY. The delivery URL and the signing secret exist only inside
// `state.reveal`, i.e. only in this component's React state, only between the
// mint/rotate response and the user closing the panel. They are never written
// to storage, never logged, never sent anywhere, and `GET /config` cannot
// bring them back — losing them means rotating, which the copy says.
//
// CONSENT VARIANTS (residual F011). The off state renders one of two pinned
// texts from `consentCopy.ts`, always verbatim — the renderer owns only the
// `**bold**`/`*em*` markers: Option C for everyone, and the B-ingest cohort
// text only when the cohort-gated meetings read API answers this session with
// an affirmative "ok" (`consentVariantForProbe`). Every other answer — the 404
// that means "not in the cohort", an auth or transport failure, a thrown
// programmer error, no `meetings` client at all — fails closed to Option C: a
// non-cohort user must never read the cohort's custody terms, and an error
// must never hide consent entirely. Under B-ingest the enable action is gated
// behind a real attestation checkbox — the user is acknowledging actual
// custody (the token, the 90-day copy), so the button stays inert until the
// box is checked.

import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CopyIcon, Loader2Icon, RadioIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BACKEND_INGEST_CONSENT_COPY,
  BACKGROUND_SYNC_CONSENT_COPY,
  type BackgroundSyncConsentCopy,
} from "@/lib/connectors/consentCopy";
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
  HISTORICAL_RESYNC_CONFIRM_COPY,
  backgroundSyncStatus,
  cancelHistoricalResync,
  confirmHistoricalResync,
  disableBackgroundSync,
  dismissReveal,
  enableBackgroundSync,
  initialBackgroundSyncState,
  loadOnMount,
  queueNotices,
  refreshQueue,
  requestHistoricalResync,
  rotateCredentials,
  syncQueuedMeetings,
  type BackgroundSyncDeps,
  type BackgroundSyncState,
  type QueueNotice,
} from "./backgroundSyncState";
import {
  enqueueDrainWork,
  publishBackgroundDrainConnectorState,
  readBackgroundDrainGeneration,
} from "./useBackgroundDrain";

// ── Container ────────────────────────────────────────────────────────

export interface BackgroundSyncSectionProps {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /** FE0's typed client, built once by the card from backendUrl + sessionStore. */
  webhooks: ConnectorWebhooksClient;
  /**
   * F011: the cohort-gated READ client, built by the card from the same two
   * props. Optional ON PURPOSE — an absent client is just one more
   * non-affirmative answer, so the off state fails closed to Option C instead
   * of failing open to the cohort text.
   */
  meetings?: ConnectorMeetingsClient;
  /** Fired after a processing run wrote meetings, so the row's count refreshes. */
  onIngested?: () => void;
  /**
   * The mount-time probe's verdict, reported up so the teardown can tell a dark
   * deployment from a 404 that means something else (see
   * `connectorLifecycle.DisconnectDeps.featureDark`). Fired only once the probe
   * has actually answered — `loading` reports nothing.
   */
  onFeatureDark?: (dark: boolean) => void;
}

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

export function BackgroundSyncSection({
  tcw,
  descriptor,
  webhooks,
  meetings,
  onIngested,
  onFeatureDark,
}: BackgroundSyncSectionProps) {
  const [state, setState] = useState<BackgroundSyncState>(initialBackgroundSyncState);
  // React may keep this mounted state around after Settings closes; an emit
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
  // mid-run when Settings opens, and two concurrent drains could re-surface
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

  return (
    <BackgroundSyncView
      state={state}
      connectorName={descriptor.name}
      consentVariant={consentVariant}
      ingestConsentChecked={ingestConsentChecked}
      onIngestConsentChange={setIngestConsentChecked}
      onEnable={() => void enableBackgroundSync(deps, emit)}
      onRotate={() => void rotateCredentials(deps, emit)}
      onDisable={() => void disableBackgroundSync(deps, emit)}
      onSync={() => void runSync()}
      onRetry={() =>
        void (state.phase === "enabled"
          ? refreshQueue(deps, emit) // read-only — no drain, no lane needed
          : enqueueDrainWork(() => loadOnMount(deps, emit)))
      }
      onDismissReveal={() => emit(dismissReveal)}
      onCopy={copyToClipboard}
      onRequestHistoricalResync={() => emit(requestHistoricalResync)}
      onCancelHistoricalResync={() => emit(cancelHistoricalResync)}
      onConfirmHistoricalResync={() => void confirmHistoricalResync(deps, emit)}
    />
  );
}

/**
 * The copy controls' only side effect. Nothing is logged on failure — the
 * value being copied is the delivery secret, and an error object can carry it.
 */
function copyToClipboard(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

// ── View ─────────────────────────────────────────────────────────────

export interface BackgroundSyncViewProps {
  state: BackgroundSyncState;
  connectorName: string;
  /**
   * F011: which pinned consent text the off state renders. Optional with a C
   * default so every pre-cohort call site — and every frozen test — keeps
   * producing byte-identical Option-C markup; only the container's probe ever
   * passes "B-ingest", and only on an affirmative cohort signal.
   */
  consentVariant?: OffStateConsentVariant;
  /** The B-ingest attestation's checked state. Unrendered (and inert) under C. */
  ingestConsentChecked?: boolean;
  onIngestConsentChange?: (checked: boolean) => void;
  onEnable: () => void;
  onRotate: () => void;
  onDisable: () => void;
  onSync: () => void;
  onRetry: () => void;
  onDismissReveal: () => void;
  onCopy: (value: string, label: string) => void;
  /** Arms the confirmation. Deliberately three separate props: asking,
   *  backing out, and going through with it are three distinct user acts. */
  onRequestHistoricalResync: () => void;
  onCancelHistoricalResync: () => void;
  onConfirmHistoricalResync: () => void;
}

export function BackgroundSyncView({
  state,
  connectorName,
  consentVariant = "C",
  ingestConsentChecked = false,
  onIngestConsentChange,
  onEnable,
  onRotate,
  onDisable,
  onSync,
  onRetry,
  onDismissReveal,
  onCopy,
  onRequestHistoricalResync,
  onCancelHistoricalResync,
  onConfirmHistoricalResync,
}: BackgroundSyncViewProps) {
  // A route-disabled 404 means the feature is not deployed here. Rendering a
  // setup control that cannot work is worse than rendering nothing.
  if (state.phase === "dark") return null;

  const status = backgroundSyncStatus(state);
  const notices = queueNotices(state);
  const busy = state.busy;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <RadioIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Background notifications
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Optional. {connectorName} tells us the moment a meeting is ready.
            </p>
          </div>
        </div>
        <span
          data-status-label={status.label}
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {status.label}
        </span>
      </div>

      {state.phase === "signed-out" && (
        <p className="text-xs text-muted-foreground">
          Sign in again to manage background notifications.
        </p>
      )}

      {state.phase === "loading" && (
        <div aria-hidden className="h-8 w-full animate-pulse rounded-md bg-muted/50" />
      )}

      {state.notice && (
        <p
          role={state.notice.tone === "error" ? "alert" : undefined}
          className={
            state.notice.tone === "error"
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {state.notice.message}
        </p>
      )}
      {state.notice?.retryable && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            aria-label="Try the last background-notification action again"
          >
            Try again
          </Button>
        </div>
      )}

      {/* Anything that is not an affirmed cohort verdict renders Option C —
          the same JSX it always rendered, so the non-cohort surface stays
          byte-identical to the frozen drain-UX increment. */}
      {state.phase === "off" && consentVariant !== "B-ingest" && (
        <>
          <ConsentCopyBlock copy={BACKGROUND_SYNC_CONSENT_COPY} />
          <div>
            <Button size="sm" onClick={onEnable} disabled={busy !== null} className="gap-1.5">
              {busy === "enabling" && (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              )}
              <span>Turn on background notifications</span>
            </Button>
          </div>
        </>
      )}

      {/* The cohort off state (F011). Same shape as C — pinned copy, then the
          enable action — plus the two fields only B-ingest carries, rendered
          verbatim like everything else from consentCopy.ts. */}
      {state.phase === "off" && consentVariant === "B-ingest" && (
        <>
          <ConsentCopyBlock copy={BACKEND_INGEST_CONSENT_COPY} />
          {/* The disconnect note sits BELOW the bullets — the last bullet
              points forward at it — as its own paragraph, markers resolved by
              the same Emphasized the bullets use. */}
          {BACKEND_INGEST_CONSENT_COPY.disconnectNote && (
            <p className="text-xs text-muted-foreground">
              <Emphasized text={BACKEND_INGEST_CONSENT_COPY.disconnectNote} />
            </p>
          )}
          {/* A real, controlled checkbox, not decoration: under B-ingest the
              user is attesting to actual custody (the token, the 90-day
              copy), so the enable action below is inert until it is checked.
              The pinned sentence is the label text, verbatim, which also
              makes it the control's accessible name. */}
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
              checked={ingestConsentChecked}
              onChange={(event) => onIngestConsentChange?.(event.target.checked)}
            />
            <span>{BACKEND_INGEST_CONSENT_COPY.consentCheckbox}</span>
          </label>
          <div>
            <Button
              size="sm"
              onClick={onEnable}
              disabled={busy !== null || !ingestConsentChecked}
              className="gap-1.5"
            >
              {busy === "enabling" && (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              )}
              <span>Turn on background notifications</span>
            </Button>
          </div>
        </>
      )}

      {state.phase === "enabled" && state.reveal && (
        <RevealPanel
          reveal={state.reveal}
          onCopy={onCopy}
          onDismiss={onDismissReveal}
        />
      )}

      {state.phase === "enabled" && !state.reveal && (
        <>
          <ul className="flex flex-col gap-2">
            {notices.map((notice) => (
              <li key={notice.kind}>
                <QueueNoticeLine notice={notice} busy={busy} onSync={onSync} onRetry={onRetry} />
              </li>
            ))}
          </ul>
          {state.lastIngest && <LastRunLine state={state} />}
          <p className="text-xs text-muted-foreground">
            Lost the signing secret? Rotating issues a new address and secret — the
            old ones stop working immediately and have to be replaced in your{" "}
            {connectorName} webhook.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRotate}
              disabled={busy !== null}
              className="gap-1.5"
            >
              {busy === "rotating" && (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              )}
              <span>Rotate webhook credentials</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDisable}
              disabled={busy !== null}
              className="gap-1.5"
            >
              {busy === "disabling" && (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              )}
              <span>Turn off background notifications</span>
            </Button>
          </div>
          <HistoricalResyncPanel
            armed={state.resyncConfirming}
            busy={busy}
            onRequest={onRequestHistoricalResync}
            onCancel={onCancelHistoricalResync}
            onConfirm={onConfirmHistoricalResync}
          />
        </>
      )}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────

const RevealPanel: FC<{
  reveal: NonNullable<BackgroundSyncState["reveal"]>;
  onCopy: (value: string, label: string) => void;
  onDismiss: () => void;
}> = ({ reveal, onCopy, onDismiss }) => (
  <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
    <p className="text-xs font-medium text-foreground">
      Paste these into Fireflies → Developer Settings → Webhooks V2
    </p>
    {reveal.rotated && (
      <p role="alert" className="text-xs text-destructive">
        Your previous address and secret have stopped working. Replace them in
        Fireflies now, or notifications will be turned away.
      </p>
    )}
    <RevealField
      label="Delivery URL"
      value={reveal.url}
      copyLabel="Copy delivery URL"
      onCopy={onCopy}
    />
    <RevealField
      label="Signing secret"
      value={reveal.secret}
      copyLabel="Copy signing secret"
      onCopy={onCopy}
    />
    <p className="text-xs text-muted-foreground">
      Select the events <span className="font-mono">meeting.transcribed</span> and{" "}
      <span className="font-mono">meeting.summarized</span>. Treat the address like
      a password — anyone holding it can tell our server one of your meetings is
      ready.
    </p>
    <p className="text-xs text-muted-foreground">
      This is the only time we can show the signing secret. It is not stored in
      this browser and it disappears when you close this. If you lose it, rotate
      the credentials for a new pair.
    </p>
    <div>
      <Button size="sm" onClick={onDismiss}>
        I&apos;ve saved these
      </Button>
    </div>
  </div>
);

/**
 * The one control that can let deleted meetings come back.
 *
 * It is NOT part of reconnecting, enabling or syncing — none of those may clear
 * the purge record, and none of them renders this. Asking shows the full
 * consequence; only the second, explicit press calls `DELETE /purged`.
 */
const HistoricalResyncPanel: FC<{
  armed: boolean;
  busy: BackgroundSyncState["busy"];
  onRequest: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ armed, busy, onRequest, onCancel, onConfirm }) => (
  <div className="flex flex-col gap-2 border-t border-border pt-2">
    <p className="text-xs font-medium text-foreground">
      {HISTORICAL_RESYNC_CONFIRM_COPY.heading}
    </p>
    {!armed && (
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRequest}
          disabled={busy !== null}
        >
          Allow historical re-sync
        </Button>
      </div>
    )}
    {armed && (
      <>
        <p className="text-xs text-muted-foreground">
          {HISTORICAL_RESYNC_CONFIRM_COPY.body}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy !== null}
            className="gap-1.5"
          >
            {busy === "clearing-ledger" && (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            )}
            <span>{HISTORICAL_RESYNC_CONFIRM_COPY.confirmLabel}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy !== null}
          >
            {HISTORICAL_RESYNC_CONFIRM_COPY.cancelLabel}
          </Button>
        </div>
      </>
    )}
  </div>
);

const RevealField: FC<{
  label: string;
  value: string;
  copyLabel: string;
  onCopy: (value: string, label: string) => void;
}> = ({ label, value, copyLabel, onCopy }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-[11px] text-foreground">
        {value}
      </code>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        aria-label={copyLabel}
        onClick={() => onCopy(value, label)}
      >
        <CopyIcon className="size-3.5" aria-hidden />
        <span>{copyLabel}</span>
      </Button>
    </div>
  </div>
);

const QueueNoticeLine: FC<{
  notice: QueueNotice;
  busy: BackgroundSyncState["busy"];
  onSync: () => void;
  onRetry: () => void;
}> = ({ notice, busy, onSync, onRetry }) => (
  <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5">
    <p
      className={
        notice.tone === "warn"
          ? "text-xs font-medium text-foreground"
          : "text-xs font-medium text-muted-foreground"
      }
    >
      {notice.title}
    </p>
    <p className="text-xs text-muted-foreground">{notice.detail}</p>
    {notice.action === "sync" && (
      <div>
        <Button size="sm" onClick={onSync} disabled={busy !== null} className="gap-1.5">
          {busy === "syncing" && (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
          )}
          <span>Sync queued meetings</span>
        </Button>
      </div>
    )}
    {notice.action === "retry" && (
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={busy !== null}
          aria-label="Check the background-notification queue again"
        >
          Check again
        </Button>
      </div>
    )}
  </div>
);

const LastRunLine: FC<{ state: BackgroundSyncState }> = ({ state }) => {
  const run = state.lastIngest;
  if (!run) return null;
  const parts = [`${run.stored} saved`];
  if (run.failed > 0) parts.push(`${run.failed} still queued`);
  if (run.unacknowledged > 0) parts.push(`${run.unacknowledged} awaiting confirmation`);
  if (run.tombstoned > 0) parts.push(`${run.tombstoned} skipped as deleted`);
  return (
    <p className="text-xs text-muted-foreground">Last collected: {parts.join(" · ")}</p>
  );
};

/**
 * A pinned consent copy, rendered verbatim — Option C for everyone, B-ingest
 * only when the off state selected it on an affirmed cohort probe.
 *
 * `consentCopy.ts` is pinned claim-by-claim against the backend's real
 * delegation scope, so this renderer restates nothing and only resolves the
 * inline `**bold**` / `*emphasis*` markers the copy carries.
 */
const ConsentCopyBlock: FC<{ copy: BackgroundSyncConsentCopy }> = ({ copy }) => (
  <div className="flex flex-col gap-2">
    <p className="text-xs font-medium text-foreground">{copy.heading}</p>
    <p className="text-xs text-muted-foreground">{copy.intro}</p>
    <p className="text-xs font-medium text-foreground">{copy.changesHeading}</p>
    <ul className="flex list-disc flex-col gap-1.5 pl-4">
      {copy.bullets.map((bullet) => (
        <li key={bullet.slice(0, 32)} className="text-xs text-muted-foreground">
          <Emphasized text={bullet} />
        </li>
      ))}
    </ul>
  </div>
);

/** Resolves `**strong**` and `*em*` runs. No other markup is interpreted. */
const Emphasized: FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter((p) => p.length > 0);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-medium text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("*") && part.endsWith("*")) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
};
