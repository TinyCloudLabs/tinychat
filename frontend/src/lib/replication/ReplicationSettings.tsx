// Settings → the per-user switch for the local copy and its wipe button (logic: replicationSwitch.ts).
//
// The switch is offered only when replication is available in this build and browser
// (isReplicationAvailable: kill switch, build flag, platform). The wipe button is offered whenever
// a local copy may exist, even if the build flag has since turned OFF. With neither, nothing
// renders: no DOM, no timers.
import { useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DatabaseIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { replicationCopyMayExist } from "./replicationCopyMarker";
import { isReplicationAvailable } from "./replicationFlag";
import { readReplicationOptIn } from "./replicationOptIn";
import { clientHasReplication } from "./replicationSignOut";
import { getReplicationStatus, subscribeReplicationStatus } from "./replicationStatus";
import { removeLocalCopyNow, setReplicationSwitch } from "./replicationSwitch";
import { ReplicationStatusLine } from "./ReplicationStatusLine";

export const REPLICATION_COPY = {
  cardTitle: "Local copy of transcripts",
  switchLabel: "Keep a local copy of my transcripts on this device",
  switchHelp: "Takes effect the next time you sign in.",
  wipeButton: "Delete local copy",
  confirm: "Delete the local copies of transcripts on this device (for every account signed in here)? They are downloaded again if you turn this back on.",
  notSaved: "Could not save this setting. Try again.",
} as const;

type Pending = "off" | "wipe";

export function ReplicationSettings({ tcw }: { tcw: TinyCloudWeb }) {
  const principal = tcw.did;
  const [available] = useState(() => isReplicationAvailable());
  const [optedIn, setOptedIn] = useState(() => readReplicationOptIn(principal));
  // Set once this session's replica was stopped here: the status line stops polling it.
  const [stopped, setStopped] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useSyncExternalStore(subscribeReplicationStatus, getReplicationStatus, getReplicationStatus);

  const copyMayExist = replicationCopyMayExist() || status.offPurgeCode !== null;
  const showSwitch = available && principal !== undefined;
  if (!showSwitch && !copyMayExist) return null;

  const turnOn = async () => {
    setError(null);
    const result = await setReplicationSwitch(true, tcw, principal!);
    if (result.status === "on") setOptedIn(true);
    else setError(REPLICATION_COPY.notSaved);
  };

  const run = async (action: Pending) => {
    setBusy(true);
    setError(null);
    try {
      if (action === "off") {
        const result = await setReplicationSwitch(false, tcw, principal!);
        if (result.status === "not-saved") { setError(REPLICATION_COPY.notSaved); return; }
        setOptedIn(false);
      } else {
        await removeLocalCopyNow(tcw, principal);
      }
      setStopped(true);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const onSwitch = (checked: boolean) => {
    if (checked) void turnOn();
    // Nothing to remove (no marker): flip without a dialog.
    else if (copyMayExist) setPending("off");
    else void run("off");
  };

  const live = clientHasReplication(tcw) && !stopped;
  return (
    <SectionCard icon={DatabaseIcon} title={REPLICATION_COPY.cardTitle}>
    <div className="flex min-w-0 flex-col gap-2 break-words text-callout" data-testid="replication-settings">
      {showSwitch && (
        <>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="size-5 shrink-0"
              checked={optedIn}
              disabled={busy}
              onChange={(event) => onSwitch(event.currentTarget.checked)}
              data-testid="replication-switch"
            />
            <span className="min-w-0">{REPLICATION_COPY.switchLabel}</span>
          </label>
          <p className="text-muted-foreground">{REPLICATION_COPY.switchHelp}</p>
        </>
      )}
      {copyMayExist && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
            disabled={busy}
            onClick={() => setPending("wipe")}
            data-testid="replication-wipe"
          >
            {REPLICATION_COPY.wipeButton}
          </Button>
        </div>
      )}
      <ReplicationStatusLine tcw={tcw} live={live} optedIn={optedIn} />
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open && !busy) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{REPLICATION_COPY.wipeButton}</AlertDialogTitle>
            <AlertDialogDescription>{REPLICATION_COPY.confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="h-8 px-3 text-xs">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => { if (pending) void run(pending); }}
              data-testid="replication-confirm"
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </SectionCard>
  );
}
