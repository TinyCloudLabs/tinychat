import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MANAGE_STORAGE_URL, STORAGE_READ_ONLY_NOTICE } from "@/lib/storageStatus";

export function StorageFullDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5 rounded-xl">
        <DialogHeader>
          <DialogTitle>Storage full: read-only.</DialogTitle>
          <DialogDescription>{STORAGE_READ_ONLY_NOTICE}</DialogDescription>
        </DialogHeader>
        <Button asChild>
          <a href={MANAGE_STORAGE_URL} target="_blank" rel="noreferrer">Manage storage</a>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
