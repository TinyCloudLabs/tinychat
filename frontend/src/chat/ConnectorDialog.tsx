// Connect + Disconnect dialogs for the Connectors settings card.
// Spec §9 — Radix Dialog conventions matched from `ImportDialog.tsx`.
//
// TWO connect machines live here, selected by the registry row (`usesOAuthConnect`):
//
//   API-KEY (Fireflies): key entry → validate → (unlock secrets) → save →
//     initial sync → done. `validateKey` distinguishes invalid-key vs
//     network-error and shows distinct inline messages; we NEVER store an
//     unvalidated key. Once the key has been saved to secrets the connector is
//     "connected"; a sync failure from that point leaves it
//     connected-with-error and the user can retry via "Sync now" on the card.
//
//   OAUTH (Google Meet, gmeet plan §4.1 / §6 WP-C): authorize → wait-callback →
//     exchange → save-token → initial-sync → done. A SECOND phase set rather
//     than a rename: the machine above hardwires `FirefliesClient.validateKey`
//     and `syncFireflies`, and there is no key field in an OAuth flow at all.
//     Load-bearing details, each of which is a bug when it is missing:
//       - the popup is opened SYNCHRONOUSLY from the click and only then
//         navigated (an `await` before `window.open` is blocked by default);
//       - the `message` listener validates BOTH the backend origin AND the
//         minted `state`, and accepts nothing but `{ code, state }`. Tokens
//         arrive only in the authenticated exchange response, never by
//         postMessage;
//       - the PKCE verifier never leaves this module's memory, and is dropped
//         after one exchange attempt;
//       - the refresh token is persisted through `connectorSecrets` under the
//         registry row's OWN `secretName`/`secretScope`, so the flip commit
//         changes what is written without touching this file. The access token
//         stays in memory for the session.
//
// Both connect flows write to the same store and reuse the same wallet-unlock
// choke point; nothing here logs a token, a transcript or a meeting title.
//
// Disconnect flow: AlertDialog confirm with a "Also delete the N synced
// meetings from my space" checkbox (default OFF), which selects between the
// two teardown plans in `connectorLifecycle.ts`. The dialog performs no step
// itself and decides no order: it supplies the dependencies, renders the
// orchestrator's progress, and reports success ONLY from `progress.done`.
//
// Both dialogs are CONTROLLED (open + onOpenChange props) so the card owns the
// "which dialog is open" state and can refresh row data on close.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as connectorStore from "@/lib/connectors/connectorStore";
import {
  deleteConnectorKey,
  getConnectorKey,
  isSecretsUnlocked,
  saveConnectorKey,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import {
  defaultFirefliesClientOptions,
  FirefliesClient,
  type FirefliesUser,
} from "@/lib/connectors/firefliesClient";
import { syncFireflies } from "@/lib/connectors/firefliesSync";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import {
  syncGoogleMeet,
  type GmeetSyncError,
  type GmeetSyncProgress,
  type GmeetSyncStore,
  type GmeetSyncSummary,
} from "@/lib/connectors/gmeetSync";
import {
  GOOGLE_MEET_CONSENT_COPY,
  GOOGLE_TESTING_MODE_REAUTH_COPY,
  type BackgroundSyncConsentCopy,
} from "@/lib/connectors/consentCopy";
import {
  disconnectRetry,
  disconnectStatusMessage,
  initialDisconnectProgress,
  runDisconnect,
  type DisconnectDeps,
  type DisconnectMode,
  type DisconnectProgress,
  type DisconnectStep,
  type DisconnectWebhooks,
} from "@/lib/connectors/connectorLifecycle";
import type {
  ConnectorDescriptor,
  SyncProgress,
  SyncResult,
} from "@/lib/connectors/types";
import { removeBackgroundDrainConnectorRecord } from "./useBackgroundDrain";
import {
  GMEET_CONNECTOR_ID,
  mintGmeetAccessToken,
} from "./useGmeetSessionSync";

const FIREFLIES_API_KEY_URL =
  "https://app.fireflies.ai/integrations/custom/fireflies";

/** Where a user removes TinyChat themselves if our upstream revoke ever fails. */
const GOOGLE_THIRD_PARTY_ACCESS_URL =
  "https://myaccount.google.com/permissions";

const GOOGLE_OAUTH_START_PATH = "/api/connectors/google/oauth/start";
const GOOGLE_OAUTH_EXCHANGE_PATH = "/api/connectors/google/oauth/exchange";
const GOOGLE_OAUTH_REVOKE_PATH = "/api/connectors/google/oauth/revoke";

// `createApiClient`'s CSRF header, spelled here for the same reason
// `webhooksApi.ts` spells it: the constants are not exported from
// `@tinyboilerplate/client`.
const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

/**
 * G3 GATE (plan §2b) — the testing-mode weekly re-auth caveat.
 *
 * The copy EXISTS now and renders from one flag, because G3 requires it live in
 * the dialog before the Google app opens beyond the team. It ships hidden: in
 * internal mode Google does not expire the token weekly, and showing a warning
 * that is currently false is its own kind of dishonesty. Flipping this to
 * `true` is the whole change when the app moves to testing mode.
 */
const SHOW_GOOGLE_TESTING_MODE_CAVEAT: boolean = false;

/** How often the wait-callback phase checks whether the popup went away. */
const POPUP_CLOSED_POLL_MS = 600;

/**
 * Which connect machine a row gets. Driven by the registry id, not by the
 * secret name: the flip commit changes `secretName` on this same row, and this
 * predicate must not move with it.
 */
export function usesOAuthConnect(descriptor: ConnectorDescriptor): boolean {
  return descriptor.id === GMEET_CONNECTOR_ID;
}

// ── Connect ───────────────────────────────────────────────────────────────

type ConnectPhase =
  | "key-entry"
  | "validating"
  | "verified"
  | "saving"
  | "syncing"
  | "done"
  | "error";

interface ConnectErrorState {
  kind:
    | "invalid-key"
    | "network"
    | "storage"
    | "rate-limited"
    | "auth"
    | "unknown";
  message: string;
  retryAfterMs?: number;
}

interface ConnectorConnectDialogProps {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /** The card's props, handed down. The OAuth machine's proxy calls need both;
   *  the API-key machine ignores them. */
  backendUrl: string;
  sessionStore: SessionStore;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fires after save+sync finishes (both ok and connected-with-error paths)
   * so the parent card can refetch the persisted connection row.
   */
  onConnected: () => void;
}

/**
 * The one entry point the card renders. Which machine runs is the registry
 * row's business, not the card's — so the card keeps one `<ConnectorConnectDialog>`
 * and a connector that changes auth style changes nothing there.
 */
export const ConnectorConnectDialog: FC<ConnectorConnectDialogProps> = (props) =>
  usesOAuthConnect(props.descriptor) ? (
    <OAuthConnectDialog {...props} />
  ) : (
    <ApiKeyConnectDialog {...props} />
  );

const ApiKeyConnectDialog: FC<ConnectorConnectDialogProps> = ({
  tcw,
  descriptor,
  open,
  onOpenChange,
  onConnected,
}) => {
  const [phase, setPhase] = useState<ConnectPhase>("key-entry");
  const [apiKey, setApiKey] = useState("");
  const [user, setUser] = useState<FirefliesUser | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [summary, setSummary] = useState<SyncResult | null>(null);
  const [error, setError] = useState<ConnectErrorState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setPhase("key-entry");
    setApiKey("");
    setUser(null);
    setProgress(null);
    setSummary(null);
    setError(null);
    abortRef.current = null;
  }, []);

  // Reset every time the dialog is (re)opened — a stale phase from the last
  // run would flash before the parent's onOpenChange lands otherwise.
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Block closing during phases that would strand irreversible progress.
  // "saving" is a mid-secrets write; "syncing" is a mid-SQL/KV write loop
  // (sequential — TinyCloud drops concurrent responses).
  const busy =
    phase === "validating" || phase === "saving" || phase === "syncing";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (busy) return;
      onOpenChange(next);
    },
    [busy, onOpenChange],
  );

  const handleClose = useCallback(() => {
    if (busy) return;
    onOpenChange(false);
  }, [busy, onOpenChange]);

  const handleContinue = useCallback(async () => {
    setError(null);
    setPhase("validating");
    const client = new FirefliesClient({ apiKey, ...defaultFirefliesClientOptions() });
    const validate = await client.validateKey();
    if (!validate.ok) {
      const kind =
        validate.error.kind === "invalid-key"
          ? "invalid-key"
          : validate.error.kind === "network-error"
            ? "network"
            : "unknown";
      setError({ kind, message: validate.error.message });
      setPhase("key-entry");
      return;
    }
    setUser(validate.data);
    setPhase("verified");
  }, [apiKey]);

  const handleSaveAndSync = useCallback(async () => {
    setError(null);
    setPhase("saving");
    if (!isSecretsUnlocked(tcw)) {
      const unlock = await unlockSecrets<SecretsErr>(tcw);
      if (!unlock.ok) {
        setError({
          kind: "storage",
          message: unlock.error?.message ?? "Could not unlock secrets",
        });
        setPhase("verified");
        return;
      }
    }
    const save = await saveConnectorKey<SecretsErr>(tcw, descriptor, apiKey);
    if (!save.ok) {
      setError({
        kind: "storage",
        message: save.error?.message ?? "Could not save API key",
      });
      setPhase("verified");
      return;
    }
    // Save landed — the connector is now "connected" from the store's POV.
    // Any sync failure below leaves the connector connected-with-error; the
    // user can retry via "Sync now" on the card.
    setPhase("syncing");
    setProgress({ phase: "listing", done: 0, total: null });
    const ac = new AbortController();
    abortRef.current = ac;
    const client = new FirefliesClient({ apiKey, ...defaultFirefliesClientOptions() });
    const syncRes = await syncFireflies({
      client,
      store: connectorStore,
      tcw,
      onProgress: setProgress,
      signal: ac.signal,
    });
    abortRef.current = null;
    // Refresh the parent's row state whether or not sync succeeded — the
    // engine's updateSyncState ran either way.
    onConnected();
    if (!syncRes.ok) {
      const kind =
        syncRes.error.kind === "auth"
          ? "auth"
          : syncRes.error.kind === "rate-limited"
            ? "rate-limited"
            : syncRes.error.kind === "storage"
              ? "storage"
              : "network";
      setError({
        kind,
        message: syncRes.error.message,
        retryAfterMs: syncRes.error.retryAfterMs,
      });
      setPhase("error");
      return;
    }
    setSummary(syncRes.data);
    setPhase("done");
  }, [apiKey, descriptor, onConnected, tcw]);

  const handleStopSync = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" hideCloseButton={busy}>
        <DialogHeader>
          <DialogTitle>Connect {descriptor.name}</DialogTitle>
          <DialogDescription>
            {descriptor.description} Your API key is stored in TinyCloud’s
            encrypted secrets — never in plain storage or the backend.
          </DialogDescription>
        </DialogHeader>

        {(phase === "key-entry" || phase === "validating") && (
          <KeyEntryPanel
            apiKey={apiKey}
            onChange={setApiKey}
            onSubmit={handleContinue}
            validating={phase === "validating"}
            error={error}
          />
        )}
        {phase === "verified" && user && (
          <VerifiedPanel user={user} error={error} />
        )}
        {phase === "saving" && <SavingPanel />}
        {phase === "syncing" && <SyncingPanel progress={progress} />}
        {phase === "done" && summary && <DonePanel summary={summary} />}
        {phase === "error" && error && <SyncFailedPanel error={error} />}

        <ConnectFooter
          phase={phase}
          canContinue={apiKey.trim().length > 0}
          onContinue={handleContinue}
          onSaveAndSync={handleSaveAndSync}
          onClose={handleClose}
          onStopSync={handleStopSync}
        />
      </DialogContent>
    </Dialog>
  );
};

const KeyEntryPanel: FC<{
  apiKey: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  validating: boolean;
  error: ConnectErrorState | null;
}> = ({ apiKey, onChange, onSubmit, validating, error }) => (
  <form
    className="flex flex-col gap-2"
    onSubmit={(e) => {
      e.preventDefault();
      if (!validating && apiKey.trim().length > 0) onSubmit();
    }}
  >
    <label htmlFor="fireflies-api-key" className="text-sm font-medium">
      Fireflies API key
    </label>
    <input
      id="fireflies-api-key"
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={apiKey}
      onChange={(e) => onChange(e.target.value)}
      disabled={validating}
      placeholder="ff-…"
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    />
    <p className="text-xs text-muted-foreground">
      <a
        href={FIREFLIES_API_KEY_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
      >
        Find your API key here
        <ExternalLinkIcon className="size-3" aria-hidden />
      </a>
    </p>
    {validating && (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        Verifying key with Fireflies…
      </p>
    )}
    {error && !validating && (
      <p role="alert" className="text-xs text-destructive">
        {formatConnectError(error)}
      </p>
    )}
    {/* Hidden submit so Enter on the input triggers the form. The visible
        button lives in the footer. */}
    <button type="submit" className="sr-only" aria-hidden tabIndex={-1}>
      Continue
    </button>
  </form>
);

const VerifiedPanel: FC<{
  user: FirefliesUser;
  error: ConnectErrorState | null;
}> = ({ user, error }) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
      <CheckCircle2Icon
        className="mt-0.5 size-4 text-primary"
        aria-hidden
      />
      <div className="min-w-0">
        <p className="font-medium">Verified with Fireflies</p>
        <p className="truncate text-xs text-muted-foreground">
          Signed in as {user.name ?? user.email ?? "your Fireflies account"}.
        </p>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">
      TinyCloud will ask for a wallet signature to unlock your encrypted
      secrets, then save this key and run an initial sync.
    </p>
    {error && (
      <p role="alert" className="text-xs text-destructive">
        {formatConnectError(error)}
      </p>
    )}
  </div>
);

const SavingPanel: FC = () => (
  <div className="flex flex-col items-center gap-2 py-4 text-sm text-muted-foreground">
    <Loader2Icon className="size-5 animate-spin" aria-hidden />
    Saving your API key to encrypted secrets…
  </div>
);

const SyncingPanel: FC<{ progress: SyncProgress | null }> = ({ progress }) => {
  const done = progress?.done ?? 0;
  const total = progress?.total ?? null;
  const label =
    progress?.phase === "listing"
      ? "Finding new meetings…"
      : total != null && total > 0
        ? `Syncing ${done}/${total} meetings…`
        : total === 0
          ? "No new meetings to sync."
          : "Syncing meetings…";
  const pct = total && total > 0 ? Math.round((done / total) * 100) : null;
  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        {label}
      </p>
      {pct != null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total ?? 0}
          aria-valuenow={done}
          aria-label="Initial sync progress"
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
};

const DonePanel: FC<{ summary: SyncResult }> = ({ summary }) => (
  <div className="flex flex-col gap-1 py-2 text-sm">
    <p className="flex items-center gap-2 text-foreground">
      <CheckCircle2Icon className="size-4 text-primary" aria-hidden />
      {summary.added} meeting{summary.added === 1 ? "" : "s"} synced.
    </p>
    {summary.skipped > 0 && (
      <p className="text-muted-foreground">
        Skipped {summary.skipped} already in your space.
      </p>
    )}
    {summary.errors.length > 0 && (
      <details className="mt-1 text-destructive">
        <summary className="cursor-pointer text-xs">
          {summary.errors.length} meeting
          {summary.errors.length === 1 ? "" : "s"} failed to sync. Show details
        </summary>
        <ul className="mt-1 space-y-0.5 pl-4 text-xs">
          {summary.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </details>
    )}
  </div>
);

const SyncFailedPanel: FC<{ error: ConnectErrorState }> = ({ error }) => (
  <div className="flex flex-col gap-2 py-2 text-sm">
    <p className="flex items-start gap-2 text-destructive">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        Connected, but the initial sync failed: {formatConnectError(error)}
      </span>
    </p>
    <p className="text-xs text-muted-foreground">
      Your API key is saved. Retry from “Sync now” on the Connectors card.
    </p>
  </div>
);

const ConnectFooter: FC<{
  phase: ConnectPhase;
  canContinue: boolean;
  onContinue: () => void;
  onSaveAndSync: () => void;
  onClose: () => void;
  onStopSync: () => void;
}> = ({
  phase,
  canContinue,
  onContinue,
  onSaveAndSync,
  onClose,
  onStopSync,
}) => (
  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    {(phase === "key-entry" || phase === "validating") && (
      <>
        <Button
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={phase === "validating"}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onContinue}
          disabled={!canContinue || phase === "validating"}
          className="gap-1.5"
        >
          {phase === "validating" && (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
          )}
          {phase === "validating" ? "Verifying…" : "Continue"}
        </Button>
      </>
    )}
    {phase === "verified" && (
      <>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSaveAndSync}>
          Save &amp; sync
        </Button>
      </>
    )}
    {phase === "saving" && (
      <Button variant="outline" size="sm" disabled className="gap-1.5">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        Saving…
      </Button>
    )}
    {phase === "syncing" && (
      <Button variant="outline" size="sm" onClick={onStopSync}>
        Stop sync
      </Button>
    )}
    {(phase === "done" || phase === "error") && (
      <Button size="sm" onClick={onClose}>
        Close
      </Button>
    )}
  </div>
);

// ── Connect (OAuth variant) ───────────────────────────────────────────────

type OAuthConnectPhase =
  | "authorize"
  | "wait-callback"
  | "exchange"
  | "save-token"
  | "initial-sync"
  | "done"
  | "error";

/**
 * Failure kinds this machine can render. The three Google needs told apart —
 * RECONNECT-NEEDED (`invalid_grant`, a revoked or expired grant), NO-ACCESS
 * (403 — the account cannot see that thing) and SLOW-DOWN (429) — are separate
 * on purpose: Listen flattened them and could not tell a user which of the
 * three had happened. Nothing here ever carries token material: the proxy
 * answers with Google's `error`/`error_description` fields only.
 */
interface OAuthErrorState {
  kind:
    | "popup-blocked"
    | "crypto-unavailable"
    | "cancelled"
    | "session"
    | "feature-dark"
    /** Google rejected THIS deployment's client credentials, not the user. */
    | "google-credentials"
    | "reconnect-needed"
    | "no-access"
    | "slow-down"
    | "no-refresh-token"
    | "storage"
    | "network"
    | "unknown";
  /** Google's own words when we have them, else "". Never rendered alone. */
  message: string;
  retryAfterMs?: number;
}

/** The post-connect, host-only auto-transcription offer (S4, G1: IN). */
interface AutoTranscriptionState {
  status: "idle" | "declined" | "working" | "on" | "not-host" | "failed";
  message?: string;
}

/** Assembled explicitly so a signature drift in connectorStore fails to compile
 *  here rather than at the first sync (same shape `useGmeetSessionSync` builds). */
const GMEET_STORE: GmeetSyncStore = {
  getConnection: connectorStore.getConnection,
  putTranscriptBody: connectorStore.putTranscriptBody,
  upsertMeeting: connectorStore.upsertMeeting,
  updateSyncState: connectorStore.updateSyncState,
  countMeetings: connectorStore.countMeetings,
};

const OAuthConnectDialog: FC<ConnectorConnectDialogProps> = ({
  tcw,
  descriptor,
  backendUrl,
  sessionStore,
  open,
  onOpenChange,
  onConnected,
}) => {
  const [phase, setPhase] = useState<OAuthConnectPhase>("authorize");
  const [error, setError] = useState<OAuthErrorState | null>(null);
  const [progress, setProgress] = useState<GmeetSyncProgress | null>(null);
  const [summary, setSummary] = useState<GmeetSyncSummary | null>(null);
  const [autoTranscription, setAutoTranscription] = useState<AutoTranscriptionState>({
    status: "idle",
  });
  const [meetingCode, setMeetingCode] = useState("");

  // Everything below is memory-only for the life of this dialog, and cleared on
  // close. The verifier in particular NEVER leaves this module — the code that
  // rides postMessage is useless without it.
  const popupRef = useRef<Window | null>(null);
  const stateRef = useRef<string | null>(null);
  const verifierRef = useRef<string | null>(null);
  const codeHandledRef = useRef(false);
  const accessTokenRef = useRef<string | null>(null);
  const refreshTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const closePopup = useCallback(() => {
    const popup = popupRef.current;
    popupRef.current = null;
    if (popup !== null && !popup.closed) popup.close();
  }, []);

  const reset = useCallback(() => {
    closePopup();
    // A closed dialog leaves nothing in flight either: the "done" phase is
    // closable while the auto-transcription PATCH is still running, and a
    // request nobody is waiting on should not outlive the surface that made it.
    abortRef.current?.abort();
    setPhase("authorize");
    setError(null);
    setProgress(null);
    setSummary(null);
    setAutoTranscription({ status: "idle" });
    setMeetingCode("");
    stateRef.current = null;
    verifierRef.current = null;
    accessTokenRef.current = null;
    refreshTokenRef.current = null;
    codeHandledRef.current = false;
    abortRef.current = null;
  }, [closePopup]);

  // Same contract as the API-key machine: a closed dialog holds no state, and
  // here that also means no stranded popup and no token left in memory.
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const busy =
    phase === "exchange" || phase === "save-token" || phase === "initial-sync";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (busy) return;
      onOpenChange(next);
    },
    [busy, onOpenChange],
  );

  const handleClose = useCallback(() => {
    if (busy) return;
    onOpenChange(false);
  }, [busy, onOpenChange]);

  const failWith = useCallback((next: OAuthErrorState) => {
    setError(next);
    setPhase("error");
  }, []);

  /** save-token → initial-sync. Reached only with both tokens in hand. */
  const saveAndSync = useCallback(
    async (accessToken: string, refreshToken: string) => {
      setPhase("save-token");
      if (!isSecretsUnlocked(tcw)) {
        const unlock = await unlockSecrets<SecretsErr>(tcw);
        if (!unlock.ok) {
          failWith({
            kind: "storage",
            message: unlock.error?.message ?? "Could not unlock secrets",
          });
          return;
        }
      }
      // The registry row names the secret; this file never spells it. That is
      // what lets the flip commit change WHAT is stored without touching here.
      const save = await saveConnectorKey<SecretsErr>(tcw, descriptor, refreshToken);
      if (!save.ok) {
        failWith({
          kind: "storage",
          message: save.error?.message ?? "Could not save the Google connection",
        });
        return;
      }

      setPhase("initial-sync");
      setProgress(null);
      const ac = new AbortController();
      abortRef.current = ac;
      const client = new GmeetClient({
        accessToken,
        // One 401 re-mints through the authenticated proxy — the refresh token
        // never leaves this scope, and the new access token stays in the client.
        refreshAccessToken: () =>
          mintGmeetAccessToken({
            backendUrl,
            sessionStore,
            refreshToken,
            signal: ac.signal,
          }),
        signal: ac.signal,
      });
      const res = await syncGoogleMeet({
        client,
        store: GMEET_STORE,
        tcw,
        onProgress: setProgress,
        signal: ac.signal,
      });
      abortRef.current = null;
      // The engine wrote the connector row either way — refresh the card.
      onConnected();
      if (!res.ok) {
        failWith(fromGmeetSyncError(res.error));
        return;
      }
      setSummary(res.data);
      setPhase("done");
    },
    [backendUrl, descriptor, failWith, onConnected, sessionStore, tcw],
  );

  /**
   * The exchange. Tokens arrive HERE and nowhere else — an authenticated XHR
   * response the popup never sees.
   */
  const runExchange = useCallback(
    async (code: string) => {
      setPhase("exchange");
      const verifier = verifierRef.current;
      // Single-use, whatever happens next: a verifier that outlives its code is
      // a replay waiting for a second postMessage.
      verifierRef.current = null;
      stateRef.current = null;
      if (verifier === null) {
        failWith({ kind: "unknown", message: "" });
        return;
      }
      const bearer = sessionStore.getToken();
      if (!bearer || sessionStore.isExpired()) {
        failWith({ kind: "session", message: "" });
        return;
      }

      let response: Response;
      try {
        response = await fetch(`${backendUrl}${GOOGLE_OAUTH_EXCHANGE_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearer}`,
            [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
          },
          body: JSON.stringify({ code, verifier }),
        });
      } catch {
        // Deliberately not narrated with the thrown message: a transport error
        // can echo the request, and this one carried an authorization code.
        failWith({ kind: "network", message: "" });
        return;
      }
      if (!response.ok) {
        failWith(await readGoogleProxyError(response));
        return;
      }

      let payload: { access_token?: unknown; refresh_token?: unknown };
      try {
        payload = (await response.json()) as {
          access_token?: unknown;
          refresh_token?: unknown;
        };
      } catch {
        failWith({ kind: "unknown", message: "" });
        return;
      }
      const accessToken =
        typeof payload.access_token === "string" ? payload.access_token : "";
      const refreshToken =
        typeof payload.refresh_token === "string" ? payload.refresh_token : "";
      if (accessToken.length === 0 || refreshToken.length === 0) {
        // `prompt=consent` is supposed to make this impossible; when it happens
        // anyway there is nothing to save, so we say so instead of half-connecting.
        failWith({ kind: "no-refresh-token", message: "" });
        return;
      }
      accessTokenRef.current = accessToken;
      refreshTokenRef.current = refreshToken;
      await saveAndSync(accessToken, refreshToken);
    },
    [backendUrl, failWith, saveAndSync, sessionStore],
  );

  /**
   * The click handler, and the reason it is not async: `window.open` must be
   * called in the same task as the user gesture or the browser blocks it. The
   * popup is opened blank, THEN navigated once the PKCE challenge is computed.
   */
  const handleAuthorize = useCallback(() => {
    setError(null);
    codeHandledRef.current = false;
    const popup = window.open(
      "about:blank",
      "tinychat-google-oauth",
      "popup=yes,width=520,height=680",
    );
    if (popup === null) {
      setError({ kind: "popup-blocked", message: "" });
      return;
    }
    popupRef.current = popup;
    setPhase("wait-callback");

    void (async () => {
      let state: string;
      let verifier: string;
      let challenge: string;
      try {
        state = randomUrlSafeToken(24);
        verifier = randomUrlSafeToken(32);
        challenge = await pkceChallengeS256(verifier);
      } catch {
        closePopup();
        setPhase("authorize");
        setError({ kind: "crypto-unavailable", message: "" });
        return;
      }
      stateRef.current = state;
      verifierRef.current = verifier;
      const url =
        `${backendUrl}${GOOGLE_OAUTH_START_PATH}` +
        `?state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}`;
      try {
        popup.location.href = url;
      } catch {
        closePopup();
        setPhase("authorize");
        setError({ kind: "cancelled", message: "" });
      }
    })();
  }, [backendUrl, closePopup]);

  /**
   * The callback listener, live only while we are waiting for one.
   *
   * Two checks, both required: the event's ORIGIN must be the backend that
   * served the callback page, and the payload's `state` must be the one this
   * click minted. Anything else on the bus is ignored silently — a page that
   * shouts at every message is a page that can be talked into an exchange.
   */
  useEffect(() => {
    if (phase !== "wait-callback") return;
    const expectedOrigin = originOf(backendUrl);

    const onMessage = (event: MessageEvent) => {
      if (expectedOrigin === null || event.origin !== expectedOrigin) return;
      const data = event.data as { code?: unknown; state?: unknown } | null;
      if (data === null || typeof data !== "object") return;
      const { code, state } = data;
      if (typeof code !== "string" || typeof state !== "string") return;
      if (stateRef.current === null || state !== stateRef.current) return;
      if (codeHandledRef.current) return;
      // Set synchronously: the popup closes itself right after posting, and the
      // closed-poll below must not overwrite a completed flow with "cancelled".
      codeHandledRef.current = true;
      closePopup();
      void runExchange(code);
    };
    window.addEventListener("message", onMessage);

    // Closed without completing = the user changed their mind (or Google's
    // consent screen was dismissed). A cancel, not a failure.
    const timer = window.setInterval(() => {
      if (codeHandledRef.current) return;
      const popup = popupRef.current;
      if (popup === null || !popup.closed) return;
      popupRef.current = null;
      setPhase("authorize");
      setError({ kind: "cancelled", message: "" });
    }, POPUP_CLOSED_POLL_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
  }, [backendUrl, closePopup, phase, runExchange]);

  const handleCancelAuthorize = useCallback(() => {
    codeHandledRef.current = true;
    closePopup();
    stateRef.current = null;
    verifierRef.current = null;
    setPhase("authorize");
    setError(null);
  }, [closePopup]);

  const handleStopSync = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * The host-only offer. A 403 means the signed-in user is not the meeting's
   * host — expected, and rendered as a calm note rather than an error, because
   * nothing is broken and nothing needs retrying.
   */
  const handleEnableAutoTranscription = useCallback(async () => {
    const accessToken = accessTokenRef.current;
    const refreshToken = refreshTokenRef.current;
    const target = meetingCode.trim();
    if (accessToken === null || refreshToken === null || target.length === 0) return;
    setAutoTranscription({ status: "working" });
    // Same handle the sync phase uses — `reset()` aborts it, so closing the
    // dialog mid-PATCH cancels the request instead of stranding it.
    const ac = new AbortController();
    abortRef.current = ac;
    const client = new GmeetClient({
      accessToken,
      refreshAccessToken: () =>
        mintGmeetAccessToken({
          backendUrl,
          sessionStore,
          refreshToken,
          signal: ac.signal,
        }),
      signal: ac.signal,
    });
    const res = await client.patchSpaceAutoTranscription(target);
    // A swapped-out handle means `reset()` ran while the PATCH was in flight:
    // it already cleared this state, and there is no longer anyone to tell.
    if (abortRef.current !== ac) return;
    abortRef.current = null;
    if (res.ok) {
      setAutoTranscription({ status: "on" });
      return;
    }
    if (res.reason === "not-host") {
      setAutoTranscription({ status: "not-host" });
      return;
    }
    setAutoTranscription({ status: "failed", message: res.error.message });
  }, [backendUrl, meetingCode, sessionStore]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" hideCloseButton={busy}>
        <DialogHeader>
          <DialogTitle>Connect {descriptor.name}</DialogTitle>
          <DialogDescription>
            Sign in with Google to sync your Meet transcripts. Your Google
            connection is stored in TinyCloud’s encrypted secrets — the
            transcripts themselves go straight from Google to your space.
          </DialogDescription>
        </DialogHeader>

        {phase === "authorize" && (
          <AuthorizePanel copy={GOOGLE_MEET_CONSENT_COPY} error={error} />
        )}
        {phase === "wait-callback" && <WaitCallbackPanel />}
        {phase === "exchange" && (
          <OAuthStepPanel label="Finishing the Google sign-in…" />
        )}
        {phase === "save-token" && (
          <OAuthStepPanel label="Saving your Google connection to encrypted secrets…" />
        )}
        {phase === "initial-sync" && <GmeetSyncingPanel progress={progress} />}
        {phase === "done" && summary && (
          <GmeetDonePanel
            summary={summary}
            autoTranscription={autoTranscription}
            meetingCode={meetingCode}
            onMeetingCodeChange={setMeetingCode}
            onEnable={() => void handleEnableAutoTranscription()}
            onDecline={() => setAutoTranscription({ status: "declined" })}
          />
        )}
        {phase === "error" && error && <OAuthFailedPanel error={error} />}

        <OAuthConnectFooter
          phase={phase}
          onAuthorize={handleAuthorize}
          onCancelAuthorize={handleCancelAuthorize}
          onClose={handleClose}
          onStopSync={handleStopSync}
        />
      </DialogContent>
    </Dialog>
  );
};

/**
 * The consent surface. `consentCopy.ts` is pinned claim-by-claim against what
 * the backend actually does, so this renderer restates nothing and only
 * resolves the inline `**bold**` / `*em*` markers the copy carries. (The same
 * job `BackgroundSyncSection`'s block does for the webhook-lane texts; its
 * renderer is private to that file and this one is deliberately a copy rather
 * than a shared export, so neither surface can quietly restyle the other's.)
 */
const AuthorizePanel: FC<{
  copy: BackgroundSyncConsentCopy;
  error: OAuthErrorState | null;
}> = ({ copy, error }) => (
  <div className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground">{copy.intro}</p>
    <p className="text-xs font-medium text-foreground">{copy.changesHeading}</p>
    <ul className="flex max-h-64 list-disc flex-col gap-1.5 overflow-y-auto pl-4">
      {copy.bullets.map((bullet) => (
        <li key={bullet.slice(0, 32)} className="text-xs text-muted-foreground">
          <Emphasized text={bullet} />
        </li>
      ))}
    </ul>
    {SHOW_GOOGLE_TESTING_MODE_CAVEAT && (
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{GOOGLE_TESTING_MODE_REAUTH_COPY}</span>
      </p>
    )}
    {error && (
      <p role="alert" className="text-xs text-destructive">
        {formatOAuthError(error)}
      </p>
    )}
  </div>
);

const WaitCallbackPanel: FC = () => (
  <div className="flex flex-col gap-2 py-2">
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" aria-hidden />
      Waiting for Google…
    </p>
    <p className="text-xs text-muted-foreground">
      Finish signing in and approve the two permissions in the Google window. If
      you don’t see it, check for a blocked or hidden popup.
    </p>
  </div>
);

const OAuthStepPanel: FC<{ label: string }> = ({ label }) => (
  <div className="flex flex-col items-center gap-2 py-4 text-sm text-muted-foreground">
    <Loader2Icon className="size-5 animate-spin" aria-hidden />
    {label}
  </div>
);

const GmeetSyncingPanel: FC<{ progress: GmeetSyncProgress | null }> = ({
  progress,
}) => {
  const total = progress?.total ?? null;
  const current = progress?.current ?? 0;
  const label =
    progress === null || progress.type === "status"
      ? "Looking for Google Meet recordings…"
      : total !== null && total > 0
        ? `Checking ${current}/${total} meetings…`
        : total === 0
          ? "No Google Meet recordings in the last 30 days."
          : "Syncing meetings…";
  const pct = total !== null && total > 0 ? Math.round((current / total) * 100) : null;
  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        {label}
      </p>
      {pct !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total ?? 0}
          aria-valuenow={current}
          aria-label="Initial sync progress"
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Done — and the one place the coverage cliff has to be said again, because
 * "0 meetings synced" is exactly where a user concludes the connector is
 * broken. D5's tone: name the cause, offer the next step.
 */
const GmeetDonePanel: FC<{
  summary: GmeetSyncSummary;
  autoTranscription: AutoTranscriptionState;
  meetingCode: string;
  onMeetingCodeChange: (value: string) => void;
  onEnable: () => void;
  onDecline: () => void;
}> = ({
  summary,
  autoTranscription,
  meetingCode,
  onMeetingCodeChange,
  onEnable,
  onDecline,
}) => {
  const synced = summary.created + summary.updated;
  return (
    <div className="flex flex-col gap-3 py-2 text-sm">
      <p className="flex items-center gap-2 text-foreground">
        <CheckCircle2Icon className="size-4 text-primary" aria-hidden />
        Google Meet connected · {synced} meeting{synced === 1 ? "" : "s"} synced.
      </p>
      {summary.skipped > 0 && (
        <p className="text-xs text-muted-foreground">
          {summary.skipped} recent meeting{summary.skipped === 1 ? "" : "s"} had no
          finished transcript yet — a transcript can take a while to appear after a
          call ends, and the next sync picks it up.
        </p>
      )}
      {synced === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing synced yet. Google only produces a transcript when the meeting’s
          host is on a paid Workspace edition and transcription was on for that
          meeting — and it keeps meeting records for about 30 days.
        </p>
      )}
      {summary.failed > 0 && (
        <p className="text-xs text-destructive">
          {summary.failed} meeting{summary.failed === 1 ? "" : "s"} failed to sync.
          Retry from “Sync now” on the Connectors card.
        </p>
      )}

      {autoTranscription.status !== "declined" && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium text-foreground">
            Turn on transcription for meetings you host
          </p>
          <p className="text-xs text-muted-foreground">
            Google can transcribe automatically for a meeting space you host, so
            future calls arrive here without anyone pressing record. Paste the
            meeting code or link — only the meeting’s host can change this.
          </p>
          <div className="flex gap-2">
            <input
              id="gmeet-space-code"
              aria-label="Google Meet meeting code or link"
              value={meetingCode}
              autoComplete="off"
              spellCheck={false}
              disabled={autoTranscription.status === "working"}
              onChange={(e) => onMeetingCodeChange(e.target.value)}
              placeholder="abc-defg-hij"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            <Button
              size="sm"
              onClick={onEnable}
              disabled={
                meetingCode.trim().length === 0 ||
                autoTranscription.status === "working"
              }
              className="shrink-0 gap-1.5"
            >
              {autoTranscription.status === "working" && (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              )}
              Turn on
            </Button>
          </div>
          {autoTranscription.status === "on" && (
            <p className="text-xs text-foreground">
              Transcription is on for that meeting space from now on.
            </p>
          )}
          {autoTranscription.status === "not-host" && (
            <p className="text-xs text-muted-foreground">
              Only the meeting host can change this. Nothing else about your
              connection changed — ask the host, or use a meeting you organise.
            </p>
          )}
          {autoTranscription.status === "failed" && (
            <p role="alert" className="text-xs text-destructive">
              Google didn’t change that setting: {autoTranscription.message}
            </p>
          )}
          <button
            type="button"
            onClick={onDecline}
            className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Not now
          </button>
        </div>
      )}
    </div>
  );
};

const OAuthFailedPanel: FC<{ error: OAuthErrorState }> = ({ error }) => (
  <div className="flex flex-col gap-2 py-2 text-sm">
    <p className="flex items-start gap-2 text-destructive">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{formatOAuthError(error)}</span>
    </p>
    <p className="text-xs text-muted-foreground">
      You can close this and try again — nothing was left half-connected.
    </p>
  </div>
);

const OAuthConnectFooter: FC<{
  phase: OAuthConnectPhase;
  onAuthorize: () => void;
  onCancelAuthorize: () => void;
  onClose: () => void;
  onStopSync: () => void;
}> = ({ phase, onAuthorize, onCancelAuthorize, onClose, onStopSync }) => (
  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    {phase === "authorize" && (
      <>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        {/* Not async, and it must stay that way — see `handleAuthorize`. */}
        <Button size="sm" onClick={onAuthorize}>
          Continue with Google
        </Button>
      </>
    )}
    {phase === "wait-callback" && (
      <Button variant="outline" size="sm" onClick={onCancelAuthorize}>
        Cancel
      </Button>
    )}
    {(phase === "exchange" || phase === "save-token") && (
      <Button variant="outline" size="sm" disabled className="gap-1.5">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        Working…
      </Button>
    )}
    {phase === "initial-sync" && (
      <Button variant="outline" size="sm" onClick={onStopSync}>
        Stop sync
      </Button>
    )}
    {(phase === "done" || phase === "error") && (
      <Button size="sm" onClick={onClose}>
        Close
      </Button>
    )}
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

// ── Disconnect ────────────────────────────────────────────────────────────

interface ConnectorDisconnectDialogProps {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /**
   * The card's typed companion client. Teardown needs exactly two of its
   * methods — `disable` and `recordPurge`. `DisconnectWebhooks` deliberately
   * does not name the ledger-clearing verb: no disconnect and no reconnect may
   * clear a purge ledger, which is why that method is unreachable from here.
   */
  webhooks: DisconnectWebhooks;
  /** The card's props, handed down. An OAuth connector's teardown revokes
   *  upstream through the authenticated proxy before anything is deleted. */
  backendUrl: string;
  sessionStore: SessionStore;
  /**
   * Whether the companion router is ESTABLISHED to be unmounted, from the
   * card's mount-time probe. Without it a 404 on `POST /purged` or
   * `DELETE /config` is a hard failure, not "nothing to do" — see
   * `connectorLifecycle.DisconnectDeps.featureDark`.
   */
  featureDark?: boolean;
  /** Count of already-synced meetings — drives the "delete N meetings" copy
   *  and hides the checkbox when there is nothing to delete. */
  itemCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}

export const ConnectorDisconnectDialog: FC<ConnectorDisconnectDialogProps> = ({
  tcw,
  descriptor,
  webhooks,
  backendUrl,
  sessionStore,
  featureDark,
  itemCount,
  open,
  onOpenChange,
  onDisconnected,
}) => {
  const [alsoPurge, setAlsoPurge] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DisconnectProgress | null>(null);
  // What the upstream revoke did, for the OAuth teardown. Reported, never
  // fatal: a Google that cannot be reached must not trap the user in a
  // connector they asked to remove.
  const [revoke, setRevoke] = useState<UpstreamRevokeState | null>(null);
  // The resume point. Held in a ref as well as in state because the retry
  // handler reads it in the same tick it was written by the failing run.
  const progressRef = useRef<DisconnectProgress | null>(null);
  const oauth = usesOAuthConnect(descriptor);

  // Fresh confirm each time the dialog opens: default "keep data" (purge OFF).
  useEffect(() => {
    if (open) {
      setAlsoPurge(false);
      setRunning(false);
      setProgress(null);
      setRevoke(null);
      progressRef.current = null;
    }
  }, [open]);

  const mode: DisconnectMode = alsoPurge ? "delete-data" : "keep-data";
  // A run that stopped part-way pins its plan: resuming a delete-data teardown
  // as keep-data (or the reverse) would skip steps by name and claim a
  // disconnect that never happened.
  const planLocked = progress !== null;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (running) return;
      onOpenChange(next);
    },
    [onOpenChange, running],
  );

  const runTeardown = useCallback(async () => {
    setRunning(true);
    const resume = progressRef.current;

    // ONE path, in one order: revoke upstream FIRST (while the token is still
    // readable — `delete-key` is about to wipe it), then the ordered local
    // teardown. Listen's trap was a disconnect that sometimes revoked and
    // sometimes did not, depending on which surface the user used; there is
    // only one surface here and it always tries. A revoke we could not perform
    // is REPORTED and does not stop the teardown: leaving the user connected
    // because Google is down would strand them with the grant AND the data.
    if (oauth && resume === null) {
      const revokeOutcome = await revokeGoogleUpstream({
        tcw,
        descriptor,
        backendUrl,
        sessionStore,
      });
      setRevoke(revokeOutcome);
      if (revokeOutcome.status === "locked") {
        // The one blocking case: without the vault we can neither read the
        // token to revoke nor delete it, so nothing has happened yet and the
        // honest state is "not disconnected, try again".
        setRunning(false);
        return;
      }
    }

    const deps: DisconnectDeps = {
      connectorId: descriptor.id,
      source: descriptor.source,
      mode: resume?.mode ?? mode,
      webhooks: oauth ? NO_DELIVERY_LANE : webhooks,
      featureDark: featureDark === true,
      secrets: {
        isUnlocked: () => isSecretsUnlocked(tcw),
        unlock: () => unlockSecrets<SecretsErr>(tcw),
        deleteKey: () => deleteConnectorKey<SecretsErr>(tcw, descriptor),
      },
      store: {
        listKnownSourceIds: () =>
          connectorStore.listKnownSourceIds(tcw, descriptor.source),
        // Wipes meetings + KV bodies + state row.
        purgeConnector: () => connectorStore.purgeConnector(tcw, descriptor.source),
        getConnection: () => connectorStore.getConnection(tcw, descriptor.id),
        countMeetings: () => connectorStore.countMeetings(tcw, descriptor.source),
        updateSyncState: (input) => connectorStore.updateSyncState(tcw, input),
      },
    };
    // The webhook half is SKIPPED, not faked: for a connector with no delivery
    // lane there is no queue to stop and no tombstone that could suppress
    // anything, so those two steps are handed to the runner already finished
    // and `NO_DELIVERY_LANE` is never called. Resuming a partial run carries
    // the same marks forward in `resume.completed`.
    const from =
      resume ??
      (oauth
        ? { ...initialDisconnectProgress(deps.mode), completed: [...WEBHOOKLESS_STEPS] }
        : undefined);
    const final = await runDisconnect(
      deps,
      (updater) =>
        setProgress((prev) =>
          updater(prev ?? initialDisconnectProgress(deps.mode)),
        ),
      from,
    );
    progressRef.current = final;
    if (!final.done) {
      // A partial teardown keeps the dialog open with its retry: the connector
      // is NOT disconnected and nothing may say that it is.
      setRunning(false);
      return;
    }
    // Settle our own state BEFORE the parent removes us from the tree —
    // onOpenChange(false) synchronously unmounts us in the parent's render;
    // a trailing setState would land in an about-to-be-dropped component.
    setRunning(false);
    // The connector is gone, so its claim on the header badge goes with it:
    // the shared drain record's entry would otherwise pin a stale count until
    // the next headless run. Success-path only — a partial teardown left the
    // connector connected, and its count still stands.
    removeBackgroundDrainConnectorRecord(descriptor.source);
    onDisconnected();
    onOpenChange(false);
  }, [
    backendUrl,
    descriptor,
    featureDark,
    mode,
    oauth,
    onDisconnected,
    onOpenChange,
    sessionStore,
    tcw,
    webhooks,
  ]);

  const retry = progress ? disconnectRetry(progress) : null;
  const statusMessage = progress
    ? oauth
      ? googleDisconnectStatusMessage(progress)
      : disconnectStatusMessage(progress)
    : null;
  const revokeMessage = revoke === null ? null : upstreamRevokeMessage(revoke);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {descriptor.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {oauth ? (
              // The copy `consentCopy.ts` pins — the same words the connect
              // dialog promised, said again where they take effect.
              <Emphasized text={GOOGLE_MEET_CONSENT_COPY.disconnectNote ?? ""} />
            ) : (
              <>
                Background notifications are turned off first, then your API key
                is removed from encrypted secrets. Your synced meeting data
                stays in your space unless you also delete it below.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {itemCount > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
              checked={alsoPurge}
              onChange={(e) => setAlsoPurge(e.target.checked)}
              disabled={running || planLocked}
            />
            <span>
              Also delete the {itemCount} synced meeting
              {itemCount === 1 ? "" : "s"} from my space.{" "}
              {oauth
                ? "They are removed from your space along with their transcripts."
                : `We record the deletion with the server first, so a late ${descriptor.name} notification can’t bring them back.`}
            </span>
          </label>
        )}

        {revokeMessage && (
          <p
            role={revoke?.status === "revoked" ? undefined : "alert"}
            className={
              revoke?.status === "revoked"
                ? "text-xs text-muted-foreground"
                : "text-xs text-destructive"
            }
          >
            {revokeMessage}
          </p>
        )}

        {statusMessage && (
          <p
            role={progress?.failure ? "alert" : undefined}
            className={
              progress?.failure
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {statusMessage}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running} className="h-8 px-3 text-xs">
            {retry ? "Close" : "Cancel"}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void runTeardown()}
            disabled={running}
            className="gap-1.5"
          >
            {running && (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            )}
            {retry
              ? retry.label
              : alsoPurge
                ? "Disconnect & delete data"
                : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────

function formatConnectError(error: ConnectErrorState): string {
  switch (error.kind) {
    case "invalid-key":
      return "Fireflies did not accept this key. Double-check that it’s your active API key.";
    case "network":
      return `Could not reach Fireflies. Check your connection and try again. (${error.message})`;
    case "rate-limited": {
      const retry = error.retryAfterMs
        ? ` Try again in ${formatRetryIn(error.retryAfterMs)}.`
        : "";
      return `Fireflies rate limit hit.${retry}`;
    }
    case "auth":
      return "Fireflies rejected the saved key mid-sync. Try disconnecting and reconnecting.";
    case "storage":
      return error.message;
    case "unknown":
    default:
      return error.message;
  }
}

function formatRetryIn(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s}s`;
  }
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${min} min`;
}

// ── OAuth teardown helpers ─────────────────────────────────────────────

/**
 * The two steps a connector with no delivery lane has nothing to do for.
 *
 * They are marked COMPLETE before the run rather than removed from the plan:
 * `connectorLifecycle` is source-generic and stays that way (the plan's "expected
 * no-op"), and the skip is a decision of THIS call site, where the fact that
 * google-meet has no webhook is actually known. `supportsBackgroundNotifications`
 * refuses the surface for this source for the same reason.
 */
const WEBHOOKLESS_STEPS: readonly DisconnectStep[] = [
  "record-purge",
  "disable-webhooks",
];

/**
 * The webhook deps for a connector that has none. Unreachable by construction
 * (both steps are pre-completed above) and, if that ever stopped being true,
 * LOUD: `feature-dark` with no established darkness is a hard failure in the
 * runner, never a silent success.
 */
const NO_DELIVERY_LANE: DisconnectWebhooks = {
  disable: () => Promise.resolve({ status: "feature-dark" }),
  recordPurge: () => Promise.resolve({ status: "feature-dark" }),
};

/** What the upstream `POST /revoke` did. Never fatal except `locked`. */
interface UpstreamRevokeState {
  status: "revoked" | "no-token" | "failed" | "locked";
  /** Google's or the vault's own words, when there are any. */
  message?: string;
}

/**
 * Ask Google to revoke the grant, before the token is deleted.
 *
 * Deliberately best-effort-and-reported rather than best-effort-and-silent: the
 * consent copy promises exactly this ("if Google cannot be reached we say so
 * instead of pretending the revoke worked"), and a swallowed failure would
 * leave a live third-party grant nobody knows about.
 *
 * The one fetch in this build that takes NO AbortSignal, on purpose: the dialog
 * is unclosable while the teardown runs, and cancelling a revoke the user asked
 * for is the one outcome worse than waiting for it — it strands the grant.
 */
async function revokeGoogleUpstream(input: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  backendUrl: string;
  sessionStore: SessionStore;
}): Promise<UpstreamRevokeState> {
  const { tcw, descriptor, backendUrl, sessionStore } = input;
  if (!isSecretsUnlocked(tcw)) {
    const unlock = await unlockSecrets<SecretsErr>(tcw);
    if (!unlock.ok) {
      return {
        status: "locked",
        message: unlock.error?.message ?? "unlock was not completed",
      };
    }
  }
  const stored = await getConnectorKey<SecretsErr>(tcw, descriptor);
  if (!stored.ok || typeof stored.data !== "string" || stored.data.length === 0) {
    // Nothing to revoke — a connector row without a readable token. Say so;
    // the teardown still has a key row and local data to clean up.
    return { status: "no-token" };
  }
  const bearer = sessionStore.getToken();
  if (!bearer || sessionStore.isExpired()) {
    return { status: "failed", message: "your TinyChat session expired" };
  }
  try {
    const response = await fetch(`${backendUrl}${GOOGLE_OAUTH_REVOKE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
      },
      body: JSON.stringify({ token: stored.data }),
    });
    if (response.ok) return { status: "revoked" };
    const failure = await readGoogleProxyError(response);
    // An already-dead grant is a revoke that has nothing left to do.
    if (failure.kind === "reconnect-needed") return { status: "revoked" };
    return {
      status: "failed",
      message: failure.message.length > 0 ? failure.message : `HTTP ${response.status}`,
    };
  } catch {
    // No thrown message: it can echo a request that carried the token.
    return { status: "failed", message: "the request did not complete" };
  }
}

function upstreamRevokeMessage(state: UpstreamRevokeState): string | null {
  switch (state.status) {
    case "revoked":
      return null;
    case "no-token":
      return `We couldn’t read a saved Google connection to revoke — remove TinyChat yourself at ${GOOGLE_THIRD_PARTY_ACCESS_URL}. The rest of the disconnect continues.`;
    case "failed":
      return `We couldn’t ask Google to revoke this access (${state.message ?? "unknown reason"}), so it may still be live. Remove TinyChat at ${GOOGLE_THIRD_PARTY_ACCESS_URL}. Everything else below still ran.`;
    case "locked":
      return `Your encrypted secrets stayed locked, so nothing was changed: ${state.message ?? "unlock was not completed"}. Try again.`;
  }
}

/**
 * The teardown status line for an OAuth connector. Only the two sentences that
 * would be WRONG here are overridden — "background notifications are off" for a
 * connector that has none, and "your API key" for a connection that is not a
 * key. Failures and the running labels stay the module's.
 */
function googleDisconnectStatusMessage(progress: DisconnectProgress): string | null {
  if (progress.done) {
    return progress.mode === "delete-data"
      ? "Disconnected. Your Google Meet meetings have been deleted from your space."
      : "Disconnected. Your Google Meet meetings are still in your space.";
  }
  if (progress.failure === null && progress.running === "delete-key") {
    return "Removing your saved Google connection…";
  }
  return disconnectStatusMessage(progress);
}

// ── OAuth helpers ──────────────────────────────────────────────────────

/** base64url, no padding — the alphabet every OAuth param below is bounded to. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A CSPRNG token. Used for the `state` nonce and the PKCE verifier — never a
 *  timestamp, never Math.random, and never derived from anything the page shows. */
function randomUrlSafeToken(byteLength: number): string {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

/** RFC 7636 S256: the challenge is the base64url SHA-256 of the verifier. Only
 *  the challenge is ever sent; the verifier stays in this module's memory. */
async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** The origin a postMessage must come from, or null if the backend URL is not
 *  parseable — in which case NO message is accepted, rather than all of them. */
function originOf(url: string): string | null {
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return null;
  }
}

/**
 * Read the proxy's structured failure. `google-oauth.ts` forwards Google's own
 * status plus `{ error, error_description }` and nothing else, which is what
 * makes reconnect-needed / no-access / slow-down distinguishable at all.
 */
async function readGoogleProxyError(response: Response): Promise<OAuthErrorState> {
  let body:
    | { error?: unknown; error_description?: unknown; upstream_status?: unknown }
    | null = null;
  try {
    body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
      upstream_status?: unknown;
    };
  } catch {
    body = null;
  }
  const code = typeof body?.error === "string" ? body.error : "";
  const description =
    typeof body?.error_description === "string" ? body.error_description : "";
  const message = description.length > 0 ? description : code;
  // `upstream_status` is present ONLY when the failure is Google's own — the
  // proxy adds it in `respondUpstreamError` and nowhere else. That is what tells
  // the two 401s apart: without it the 401 is `authMiddleware`'s (the user's
  // TinyChat session), with it Google rejected OUR client credentials, which
  // signing in again can never fix. Same for a 404: the proxy's means the route
  // is dark, Google's does not.
  const fromGoogle = typeof body?.upstream_status === "number";

  if (code === "invalid_grant" || code === "invalid_token") {
    return { kind: "reconnect-needed", message };
  }
  if (!fromGoogle && response.status === 404) return { kind: "feature-dark", message };
  if (!fromGoogle && response.status === 401) return { kind: "session", message };
  if (fromGoogle && response.status === 401) {
    return { kind: "google-credentials", message };
  }
  if (response.status === 403) return { kind: "no-access", message };
  if (response.status === 429 || code === "slow_down") {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    return retryAfterMs === null
      ? { kind: "slow-down", message }
      : { kind: "slow-down", message, retryAfterMs };
  }
  return { kind: "network", message };
}

function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

/** The sync engine's terminal error, in this dialog's vocabulary. */
function fromGmeetSyncError(error: GmeetSyncError): OAuthErrorState {
  switch (error.kind) {
    case "auth":
      return { kind: "reconnect-needed", message: error.message };
    case "forbidden":
      return { kind: "no-access", message: error.message };
    case "rate-limited":
      return error.retryAfterMs === undefined
        ? { kind: "slow-down", message: error.message }
        : { kind: "slow-down", message: error.message, retryAfterMs: error.retryAfterMs };
    case "storage":
      return { kind: "storage", message: error.message };
    default:
      return { kind: "network", message: error.message };
  }
}

/**
 * Every rendered OAuth failure string. Google's own words are appended when we
 * have them — they are `error`/`error_description` fields, which carry no token
 * material — and every kind ends with something the user can actually do.
 */
function formatOAuthError(error: OAuthErrorState): string {
  const detail = error.message.length > 0 ? ` (${error.message})` : "";
  switch (error.kind) {
    case "popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow popups for this site, then press “Continue with Google” again.";
    case "crypto-unavailable":
      return "This browser couldn’t prepare a secure sign-in. Google Meet needs a secure (https) page with Web Crypto available.";
    case "cancelled":
      return "The Google window closed before sign-in finished. Nothing was connected — press “Continue with Google” to try again.";
    case "session":
      return "Your TinyChat session expired before Google could finish. Sign in again, then reconnect.";
    case "feature-dark":
      return "Google Meet connecting isn’t switched on for this deployment yet.";
    case "google-credentials":
      return `Google refused this deployment’s own Google credentials, so signing in again won’t help — this one is ours to fix. Try again later, and report it if it keeps happening${detail}.`;
    case "reconnect-needed":
      return `Google no longer accepts this connection — it was revoked or has expired. Connect again to re-approve it${detail}.`;
    case "no-access":
      return `Google refused: this account doesn’t have access to that${detail}.`;
    case "slow-down": {
      const retry = error.retryAfterMs
        ? ` Try again in ${formatRetryIn(error.retryAfterMs)}.`
        : " Try again shortly.";
      return `Google is rate-limiting us.${retry}${detail}`;
    }
    case "no-refresh-token":
      return `Google didn’t return the long-lived permission we need to keep syncing. Remove TinyChat at ${GOOGLE_THIRD_PARTY_ACCESS_URL} and connect again.`;
    case "storage":
      return error.message.length > 0
        ? error.message
        : "Your encrypted secrets couldn’t be written, so nothing was saved.";
    case "network":
      return error.message.length > 0
        ? `Couldn’t reach Google. Check your connection and try again. (${error.message})`
        : "Couldn’t reach Google. Check your connection and try again.";
    case "unknown":
    default:
      return "The Google sign-in couldn’t be completed. Try connecting again.";
  }
}
