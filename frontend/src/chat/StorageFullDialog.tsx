import { useContext } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NATIVE_PLAN_NOTE, STORAGE_FULL_DETAIL, STORAGE_FULL_RECORDING_LINE } from "@/lib/storageStatus";
import { billingLinksAllowed, openManageStorage } from "@/lib/openManageStorage";
import { PlatformContext } from "@/lib/platform";
import { useStorageFreePlan } from "@/lib/useStorageFreePlan";

/** The storage-full sentence. The detail (what deletions can and can't do) is for the Settings banner and this dialog only. */
export function StorageFullMessage({ detail }: { detail: boolean }) {
  const storageFree = useStorageFreePlan();
  return (
    <>
      {STORAGE_FULL_RECORDING_LINE}
      {detail && <> {STORAGE_FULL_DETAIL[storageFree ? "free" : "paid"]}</>}
    </>
  );
}

export function StorageFullDialog({ open, onOpenChange, paywallEnabled }: { open: boolean; onOpenChange: (open: boolean) => void; paywallEnabled: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5 rounded-xl">
        <DialogHeader>
          <DialogTitle>Storage full</DialogTitle>
          <DialogDescription><StorageFullMessage detail /></DialogDescription>
        </DialogHeader>
        <StorageFullActions paywallEnabled={paywallEnabled} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Web and desktop: Manage storage always; Upgrade only for a positively Free plan with the paywall on. Both open through
 * the external opener. The iOS and Android apps link to no purchase page: they say where to manage the plan, as plain text.
 */
export function StorageFullActions({ paywallEnabled }: { paywallEnabled: boolean }) {
  const platform = useContext(PlatformContext);
  const canUpgrade = useStorageFreePlan() && paywallEnabled;
  if (!billingLinksAllowed(platform)) return <p className="text-sm text-muted-foreground">{NATIVE_PLAN_NOTE}</p>;
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={() => void openManageStorage()}>Manage storage</Button>
      {canUpgrade && (
        <Button type="button" variant="outline" onClick={() => void openManageStorage()}>Upgrade</Button>
      )}
    </div>
  );
}
