import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { STORAGE_FULL_DETAIL, STORAGE_FULL_RECORDING_LINE } from "@/lib/storageStatus";
import { openManageStorage } from "@/lib/openManageStorage";
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
          <DialogTitle>Storage full: read-only.</DialogTitle>
          <DialogDescription><StorageFullMessage detail /></DialogDescription>
        </DialogHeader>
        <StorageFullActions paywallEnabled={paywallEnabled} />
      </DialogContent>
    </Dialog>
  );
}

/** Manage storage always; Upgrade only for a positively Free plan with the paywall on. Both open through the external opener. */
export function StorageFullActions({ paywallEnabled }: { paywallEnabled: boolean }) {
  const canUpgrade = useStorageFreePlan() && paywallEnabled;
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={() => void openManageStorage()}>Manage storage</Button>
      {canUpgrade && (
        <Button type="button" variant="outline" onClick={() => void openManageStorage()}>Upgrade</Button>
      )}
    </div>
  );
}
