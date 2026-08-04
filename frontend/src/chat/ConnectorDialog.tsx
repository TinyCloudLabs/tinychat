// Connect + Disconnect dialogs for the Connectors settings card.
// Spec §9 — Radix Dialog conventions matched from `ImportDialog.tsx`.
//
// Connect flow: key entry → validate → (unlock secrets) → save → initial
// sync → done. `validateKey` distinguishes invalid-key vs network-error and
// shows distinct inline messages; we NEVER store an unvalidated key. Once the
// key has been saved to secrets the connector is "connected"; a sync failure
// from that point leaves it connected-with-error and the user can retry via
// "Sync now" on the card.
//
// Disconnect flow: AlertDialog confirm with a "Also delete the N synced
// meetings from my space" checkbox (default OFF). Confirm → deleteConnectorKey
// + (optional) purgeConnector + updateSyncState.
//
// Both dialogs are CONTROLLED (open + onOpenChange props) so the card owns the
// "which dialog is open" state and can refresh row data on close.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
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
import type {
  ConnectorDescriptor,
  SyncProgress,
  SyncResult,
} from "@/lib/connectors/types";

const FIREFLIES_API_KEY_URL =
  "https://app.fireflies.ai/integrations/custom/fireflies";

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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fires after save+sync finishes (both ok and connected-with-error paths)
   * so the parent card can refetch the persisted connection row.
   */
  onConnected: () => void;
}

export const ConnectorConnectDialog: FC<ConnectorConnectDialogProps> = ({
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

// ── Disconnect ────────────────────────────────────────────────────────────

interface ConnectorDisconnectDialogProps {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
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
  itemCount,
  open,
  onOpenChange,
  onDisconnected,
}) => {
  const [alsoPurge, setAlsoPurge] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh confirm each time the dialog opens: default "keep data" (purge OFF).
  useEffect(() => {
    if (open) {
      setAlsoPurge(false);
      setError(null);
      setRunning(false);
    }
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (running) return;
      onOpenChange(next);
    },
    [onOpenChange, running],
  );

  const handleConfirm = useCallback(async () => {
    setRunning(true);
    setError(null);
    if (!isSecretsUnlocked(tcw)) {
      const unlock = await unlockSecrets<SecretsErr>(tcw);
      if (!unlock.ok) {
        setError(unlock.error?.message ?? "Could not unlock secrets");
        setRunning(false);
        return;
      }
    }
    const del = await deleteConnectorKey<SecretsErr>(tcw, descriptor);
    if (!del.ok) {
      setError(del.error?.message ?? "Could not delete API key");
      setRunning(false);
      return;
    }
    if (alsoPurge) {
      // purgeConnector wipes meetings + KV bodies + state row.
      const purge = await connectorStore.purgeConnector(tcw, descriptor.source);
      if (!purge.ok) {
        setError(purge.error.message);
        setRunning(false);
        return;
      }
    } else {
      // Data stays; flip the state row to "disconnected" so the card
      // renders the reconnect state on next mount. Preserve lastSyncedAt
      // so reconnect shows the true "last synced" — the meetings are still
      // there and clearing the timestamp would mislead as "never synced".
      // Sequential — TinyCloud drops concurrent responses on the same space.
      const existingRes = await connectorStore.getConnection(tcw, descriptor.id);
      if (!existingRes.ok) {
        setError(existingRes.error.message);
        setRunning(false);
        return;
      }
      const countRes = await connectorStore.countMeetings(tcw, descriptor.source);
      if (!countRes.ok) {
        setError(countRes.error.message);
        setRunning(false);
        return;
      }
      const upd = await connectorStore.updateSyncState(tcw, {
        connectorId: descriptor.id,
        status: "disconnected",
        lastSyncedAt: existingRes.data?.lastSyncedAt ?? null,
        lastSyncStatus: existingRes.data?.lastSyncStatus ?? null,
        lastSyncError: null,
        itemCount: countRes.data,
      });
      if (!upd.ok) {
        setError(upd.error.message);
        setRunning(false);
        return;
      }
    }
    // Settle our own state BEFORE the parent removes us from the tree —
    // onOpenChange(false) synchronously unmounts us in the parent's render;
    // a trailing setState would land in an about-to-be-dropped component.
    setRunning(false);
    onDisconnected();
    onOpenChange(false);
  }, [alsoPurge, descriptor, onDisconnected, onOpenChange, tcw]);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {descriptor.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Your API key will be removed from encrypted secrets. Your synced
            meeting data stays in your space unless you also delete it below.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {itemCount > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
              checked={alsoPurge}
              onChange={(e) => setAlsoPurge(e.target.checked)}
              disabled={running}
            />
            <span>
              Also delete the {itemCount} synced meeting
              {itemCount === 1 ? "" : "s"} from my space.
            </span>
          </label>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={running}
            className="h-8 px-3 text-xs"
          >
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirm}
            disabled={running}
            className="gap-1.5"
          >
            {running && (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            )}
            {alsoPurge ? "Disconnect & delete data" : "Disconnect"}
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
