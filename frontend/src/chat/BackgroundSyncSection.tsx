// The Connectors surface for background notifications.
//
// It sits INSIDE the Fireflies connector row and is deliberately a separate,
// optional thing from "Fireflies connected": the connector works without it,
// and turning it on is a second, explicit choice. Nothing here is a new visual
// system — same SectionCard/Button/muted-text language as the rest of TinyChat.
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
// CONSENT. The off state shows Fireflies Option C's pinned copy, then selects
// its transcript-writer disclosure from the shared delegation status. Inactive
// keeps the pinned original bytes; unknown shows the disclosure. The renderer
// owns only `**bold**`/`*em*` markers.

import type { FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CopyIcon, Loader2Icon, RadioIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import {
  BACKGROUND_SYNC_CONSENT_COPY,
  transcriptAwareConsentCopy,
  type BackgroundSyncConsentCopy,
} from "@/lib/connectors/consentCopy";
import type { TranscriptConsentState } from "@/lib/transcriptDeliveryState";
import type { ConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import {
  HISTORICAL_RESYNC_CONFIRM_COPY,
  backgroundSyncStatus,
  cancelHistoricalResync,
  confirmHistoricalResync,
  disableBackgroundSync,
  dismissReveal,
  enableBackgroundSync,
  queueNotices,
  requestHistoricalResync,
  rotateCredentials,
  type BackgroundSyncState,
  type BackgroundSyncStatus,
  type QueueNotice,
} from "./backgroundSyncState";

/** The status label's dot: "On" in primary, a problem in warning, everything else neutral. */
const STATUS_TONE: Readonly<Record<BackgroundSyncStatus["tone"], StatusTone>> = {
  ok: "primary",
  warn: "warning",
  off: "neutral",
  muted: "neutral",
};
import { useBackgroundSync } from "./useBackgroundSync";

// ── Container ────────────────────────────────────────────────────────

export interface BackgroundSyncSectionProps {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /** FE0's typed client, built once by the card from backendUrl + sessionStore. */
  webhooks: ConnectorWebhooksClient;
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

export function BackgroundSyncSection(props: BackgroundSyncSectionProps) {
  const sync = useBackgroundSync(props);
  const { state, deps, emit } = sync;
  return (
    <BackgroundSyncView
      state={state}
      connectorName={props.descriptor.name}
      transcriptConsent={sync.transcriptConsent}
      onEnable={() => void enableBackgroundSync(deps, emit)}
      onRotate={() => void rotateCredentials(deps, emit)}
      onDisable={() => void disableBackgroundSync(deps, emit)}
      onSync={() => void sync.runSync()}
      onRetry={sync.retry}
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
  /** Unknown status shows the transcript-writer disclosure, not an untrue denial. */
  transcriptConsent?: TranscriptConsentState;
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
  transcriptConsent = "unknown",
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
  const consentCopy = transcriptAwareConsentCopy(BACKGROUND_SYNC_CONSENT_COPY, transcriptConsent);

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <RadioIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="flex items-center text-sm font-medium text-foreground">
              Background notifications
              <InfoTip label="About background notifications" className="-my-3 fine:-my-1">
                Optional. {connectorName} tells us the moment a meeting is ready.
              </InfoTip>
            </p>
          </div>
        </div>
        <StatusDot
          tone={STATUS_TONE[status.tone]}
          data-status-label={status.label}
          className="shrink-0 text-xs font-medium text-muted-foreground"
        >
          {status.label}
        </StatusDot>
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

      {/* Option C's pinned copy; its inactive rendering preserves the original
          copy byte for byte. */}
      {state.phase === "off" && (
        <>
          <ConsentCopyBlock copy={consentCopy} />
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
    <span className="text-xs font-medium text-muted-foreground">
      {label}
    </span>
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs text-foreground">
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
 * A pinned consent copy, rendered verbatim.
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
