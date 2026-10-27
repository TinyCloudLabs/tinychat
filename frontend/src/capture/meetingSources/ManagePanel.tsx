// What "Manage" opens on a connected source. For Fireflies that is Instant
// updates (the background-notification webhook), Bring back deleted meetings
// and Disconnect; every other source gets Disconnect alone. The rules all live
// in `chat/backgroundSyncState.ts` — this file renders the state it reports and
// hands intent back, exactly as `BackgroundSyncView` does for the flag-off page.
import { CircleAlertIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  BACKEND_INGEST_CONSENT_COPY,
  BACKGROUND_SYNC_CONSENT_COPY,
  transcriptAwareConsentCopy,
  type BackgroundSyncConsentCopy,
} from "@/lib/connectors/consentCopy";
import type { TranscriptConsentState } from "@/lib/transcriptDeliveryState";
import {
  backgroundSyncStatus,
  queueNotices,
  type BackgroundSyncState,
} from "@/chat/backgroundSyncState";
import type { OffStateConsentVariant } from "@/chat/useBackgroundSync";
import { pairFirefliesAgent } from "@/lib/firefliesAgentGrant";
import { InlineError, LinkButton, OptionRow, Switch } from "./MeetingSourcesView";

/** The window's own words for the webhook state; "Enabled in TinyChat" is the old product name. */
export function instantUpdatesLabel(state: BackgroundSyncState): string {
  if (state.phase === "signed-out") return "Sign in again to manage instant updates.";
  if (state.phase === "enabled") return "On";
  return backgroundSyncStatus(state).label;
}

/** Resolves the `**strong**` / `*em*` runs the pinned consent copy carries. Nothing else is interpreted. */
function Marked({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter((part) => part.length > 0);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function ConsentBlock({ copy }: { copy: BackgroundSyncConsentCopy }) {
  return (
    <div className="ms-consent">
      <b>{copy.heading}</b>
      <p>{copy.intro}</p>
      <b>{copy.changesHeading}</b>
      <ul>
        {copy.bullets.map((bullet) => (
          <li key={bullet.slice(0, 32)}>
            <Marked text={bullet} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface FirefliesManageProps {
  connectorName: string;
  state: BackgroundSyncState;
  consentVariant: OffStateConsentVariant;
  /** TC-641: unknown shows the transcript-writer disclosure, not an untrue denial. */
  transcriptConsent?: TranscriptConsentState;
  ingestConsentChecked: boolean;
  /** The user pressed the switch while it was off: the consent is showing, nothing is enabled yet. */
  consentOpen: boolean;
  onIngestConsentChange: (checked: boolean) => void;
  onToggleInstant: () => void;
  onConfirmEnable: () => void;
  onCancelEnable: () => void;
  onRotate: () => void;
  onDismissReveal: () => void;
  onCopy: (value: string) => void;
  onSync: () => void;
  onRetry: () => void;
  onBringBack: () => void;
  onDisconnect: () => void;
  /** A sync this window started is still running: Disconnect waits for it. */
  syncing?: boolean;
}

export function FirefliesManage(props: FirefliesManageProps) {
  const { state, connectorName } = props;
  const dark = state.phase === "dark";
  const enabled = state.phase === "enabled";
  const settled = state.phase === "off" || enabled;
  const notices = queueNotices(state);
  const busy = state.busy !== null;
  const consentCopy = transcriptAwareConsentCopy(
    props.consentVariant === "B-ingest" ? BACKEND_INGEST_CONSENT_COPY : BACKGROUND_SYNC_CONSENT_COPY,
    props.transcriptConsent ?? "unknown",
  );

  return (
    <>
      {!dark && (
        <OptionRow
          title="Instant updates"
          control={
            <Switch
              checked={enabled}
              label="Instant updates"
              disabled={busy || !settled}
              onToggle={props.onToggleInstant}
            />
          }
        >
          <p className="ms-opt-text">
            New meetings arrive as soon as {connectorName} finishes them, not at the next sync. Uses
            a webhook in your {connectorName} settings.
          </p>
          {state.phase !== "off" && (
            <p className="ms-opt-text ms-opt-state" data-phase={state.phase}>
              {(state.phase === "unavailable" || state.phase === "signed-out") && (
                <CircleAlertIcon aria-hidden="true" />
              )}
              <span>{instantUpdatesLabel(state)}</span>
            </p>
          )}
          {enabled && !state.reveal && (
            <LinkButton chevron disabled={busy} onClick={props.onRotate}>
              Rotate the webhook secret
            </LinkButton>
          )}
        </OptionRow>
      )}

      {state.notice && (
        <div className="ms-note" data-tone={state.notice.tone}>
          {state.notice.tone === "error" ? (
            <InlineError>{state.notice.message}</InlineError>
          ) : (
            <p>{state.notice.message}</p>
          )}
          {state.notice.retryable && (
            <LinkButton onClick={props.onRetry}>Try again</LinkButton>
          )}
        </div>
      )}

      {state.phase === "off" && props.consentOpen && (
        <div className="ms-subpanel">
          <ConsentBlock copy={consentCopy} />
          {props.consentVariant === "B-ingest" && (
            <>
              {consentCopy.disconnectNote && (
                <p className="ms-consent-note">
                  <Marked text={consentCopy.disconnectNote} />
                </p>
              )}
              <label className="ms-check">
                <input
                  type="checkbox"
                  checked={props.ingestConsentChecked}
                  onChange={(event) => props.onIngestConsentChange(event.target.checked)}
                />
                <span>{consentCopy.consentCheckbox}</span>
              </label>
            </>
          )}
          <div className="ms-subpanel-actions">
            <button
              type="button"
              className="ms-btn1"
              aria-disabled={busy || (props.consentVariant === "B-ingest" && !props.ingestConsentChecked)}
              onClick={() => {
                if (!busy && (props.consentVariant !== "B-ingest" || props.ingestConsentChecked)) {
                  props.onConfirmEnable();
                }
              }}
            >
              {state.busy === "enabling" ? "Turning on…" : "Turn on instant updates"}
            </button>
            <button type="button" className="ms-btn2" onClick={props.onCancelEnable}>
              Not now
            </button>
          </div>
        </div>
      )}

      {enabled && state.reveal && (
        <div className="ms-subpanel" role="group" aria-label="Webhook address and secret">
          <b>Paste these into Fireflies → Developer Settings → Webhooks V2</b>
          {state.reveal.rotated && (
            <InlineError>
              Your previous address and secret have stopped working. Replace them in {connectorName}{" "}
              now, or notifications will be turned away.
            </InlineError>
          )}
          <RevealField label="Delivery URL" value={state.reveal.url} onCopy={props.onCopy} />
          <RevealField label="Signing secret" value={state.reveal.secret} onCopy={props.onCopy} />
          <p className="ms-opt-text">
            Select the events <code>meeting.transcribed</code> and <code>meeting.summarized</code>.
            Treat the address like a password. This is the only time we can show the signing secret;
            if you lose it, rotate for a new pair.
          </p>
          <div className="ms-subpanel-actions">
            <button type="button" className="ms-btn1" data-reveal-done="" onClick={props.onDismissReveal}>
              I&apos;ve saved these
            </button>
          </div>
        </div>
      )}

      {enabled && !state.reveal && notices.length > 0 && (
        <ul className="ms-notices">
          {notices.map((notice) => (
            <li key={notice.kind} data-tone={notice.tone}>
              <b>{notice.title}</b>
              <p className="ms-opt-text">{notice.detail}</p>
              {notice.action === "sync" && (
                <LinkButton disabled={busy} onClick={props.onSync}>
                  {state.busy === "syncing" ? "Syncing…" : "Sync queued meetings"}
                </LinkButton>
              )}
              {notice.action === "retry" && (
                <LinkButton disabled={busy} onClick={props.onRetry}>
                  Check again
                </LinkButton>
              )}
            </li>
          ))}
        </ul>
      )}

      {!dark && (
        <OptionRow title="Bring back deleted meetings">
          <p className="ms-opt-text">
            Meetings you deleted here are collected again if {connectorName} reports them. You are
            asked first.
          </p>
          <LinkButton chevron disabled={busy} onClick={props.onBringBack}>
            Allow deleted meetings back
          </LinkButton>
        </OptionRow>
      )}

      <DisconnectRow name={connectorName} onDisconnect={props.onDisconnect} syncing={props.syncing} />
    </>
  );
}

export const DISCONNECT_WHILE_SYNCING =
  "A sync is still running. Stop it or wait for it to finish, then disconnect.";

export function DisconnectRow({
  name,
  onDisconnect,
  syncing = false,
}: {
  name: string;
  onDisconnect: () => void;
  /** A sync this window started has not settled: its final write would undo the disconnect. */
  syncing?: boolean;
}) {
  return (
    <div className="ms-opt">
      <div className="ms-opt-copy">
        <LinkButton danger disabled={syncing} onClick={onDisconnect}>
          Disconnect {name}
        </LinkButton>
        {syncing && <p className="ms-opt-text">{DISCONNECT_WHILE_SYNCING}</p>}
      </div>
    </div>
  );
}

function RevealField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="ms-reveal">
      <span className="ms-reveal-label">{label}</span>
      <code className="ms-reveal-value">{value}</code>
      <button
        type="button"
        className="ms-icon-btn"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => onCopy(value)}
      >
        <CopyIcon aria-hidden="true" />
      </button>
    </div>
  );
}
export function FirefliesAgentSync({ tcw }: { tcw: TinyCloudWeb }) {
  const [recipientDid, setRecipientDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "success"; message: string } | null>(null);

  async function pair() {
    setBusy(true);
    setStatus(null);
    try {
      const artifact = await pairFirefliesAgent(tcw, recipientDid);
      const url = URL.createObjectURL(new Blob([artifact], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "fireflies-named-grant.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus({
        tone: "success",
        message: "Grant downloaded. Move it to ~/.local/state/connector-sync/fireflies-named-grant.json on the agent-sync host.",
      });
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Could not create the Fireflies grant.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <OptionRow title="Pair local agent-sync">
      <p className="ms-opt-text">
        The active TinyCloud session signs a terminal grant for this agent: Fireflies envelope read and Fireflies
        named-key decrypt only. It cannot delegate further and lasts 29 days. No wallet prompt is expected; if this
        session cannot issue the grant, sign out and back in before pairing.
      </p>
      <label className="ms-agent-pair-field">
        <span>Agent session DID</span>
        <input
          autoComplete="off"
          spellCheck={false}
          value={recipientDid}
          onChange={(event) => setRecipientDid(event.target.value)}
          placeholder="did:key:z…"
          aria-label="Agent session DID"
        />
      </label>
      <div className="ms-subpanel-actions">
        <button type="button" className="ms-btn2" disabled={busy || !recipientDid.trim()} onClick={() => void pair()}>
          {busy ? "Creating grant…" : "Create grant file"}
        </button>
      </div>
      {status?.tone === "error" && <InlineError>{status.message}</InlineError>}
      {status?.tone === "success" && <p role="status" className="ms-opt-text">{status.message}</p>}
    </OptionRow>
  );
}
