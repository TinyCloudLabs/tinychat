import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { STORAGE_FULL_DETAIL, STORAGE_READ_ONLY_NOTICE } from "@/lib/storageStatus";
import { openManageStorage } from "@/lib/openManageStorage";
import { useStorageFreePlan } from "@/lib/useStorageFreePlan";

export function StorageFullDialog({ open, onOpenChange, paywallEnabled }: { open: boolean; onOpenChange: (open: boolean) => void; paywallEnabled: boolean }) {
  const storageFreePlan = useStorageFreePlan(paywallEnabled);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5 rounded-xl">
        <DialogHeader>
          <DialogTitle>Storage full: read-only.</DialogTitle>
          <DialogDescription>{STORAGE_READ_ONLY_NOTICE} {STORAGE_FULL_DETAIL[storageFreePlan ? "free" : "paid"]}</DialogDescription>
        </DialogHeader>
        <StorageFullActions paywallEnabled={paywallEnabled} />
      </DialogContent>
    </Dialog>
  );
}

/** Manage storage always; Upgrade only for a positively Free plan. Both open through the external opener. */
export function StorageFullActions({ paywallEnabled }: { paywallEnabled: boolean }) {
  const storageFreePlan = useStorageFreePlan(paywallEnabled);
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={() => void openManageStorage()}>Manage storage</Button>
      {storageFreePlan && (
        <Button type="button" variant="outline" onClick={() => void openManageStorage()}>Upgrade</Button>
      )}
    </div>
  );
}
