import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function PendingVoiceNoteSignOutDialog({
  open,
  count,
  error,
  busy,
  onSave,
  onDelete,
  onCancel,
}: {
  open: boolean;
  count: number;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const message = count === 1
    ? "1 voice note is only on this device. Save it to your TinyCloud space before you sign out, or it’ll be deleted from this device."
    : `${count} voice notes are only on this device. Save them to your TinyCloud space before you sign out, or they’ll be deleted from this device.`;

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <AlertDialogContent data-testid="pending-voice-note-signout" className="w-[calc(100%-2rem)] max-w-sm gap-5 p-6">
        <AlertDialogHeader className="gap-2 text-left">
          <AlertDialogTitle>Some voice notes aren’t saved yet</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="m-0 text-sm text-destructive">{error}</p>}
        <div className="flex flex-col gap-2">
          <Button type="button" onClick={onSave} disabled={busy} className="min-h-11 w-full">
            Save and sign out
          </Button>
          <Button type="button" variant="destructive" onClick={onDelete} disabled={busy} className="min-h-11 w-full">
            Sign out and delete them
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy} className="min-h-11 w-full">
            Cancel
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
