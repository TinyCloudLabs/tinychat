import { deviceName } from "@/lib/platform";
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
  allowKeep = true,
  count,
  error,
  busy,
  onKeep,
  onDelete,
  onCancel,
}: {
  open: boolean;
  allowKeep?: boolean;
  count: number;
  error: string | null;
  busy: boolean;
  onKeep: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const d = deviceName();
  const title = !allowKeep ? (count === 1 ? "A voice note isn't saved yet" : "Some voice notes aren't saved yet") : count === 1 ? `A voice note is still on ${d}` : `Voice notes are still on ${d}`;
  const message = !allowKeep ? `${count === 1 ? "1 voice note is" : `${count} voice notes are`} only on this device. Save ${count === 1 ? "it" : "them"} to your TinyCloud space before you sign out, or ${count === 1 ? "it’ll" : "they’ll"} be deleted from this device.` : count === 1
    ? `1 voice note hasn't been saved to your TinyCloud yet. It stays on ${d} for this account, and it'll be here when you sign back in. Or delete it now.`
    : `${count} voice notes haven't been saved to your TinyCloud yet. They stay on ${d} for this account, and they'll be here when you sign back in. Or delete them now.`;

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <AlertDialogContent data-testid="pending-voice-note-signout" className="w-[calc(100%-2rem)] max-w-sm gap-5 p-6">
        <AlertDialogHeader className="gap-2 text-left">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="m-0 text-sm text-destructive">{error}</p>}
        <div className="flex flex-col gap-2">
          <Button type="button" onClick={onKeep} disabled={busy} className="min-h-11 w-full">
            {allowKeep ? "Keep & sign out" : "Save and sign out"}
          </Button>
          <Button type="button" variant="destructive" onClick={onDelete} disabled={busy} className="min-h-11 w-full">
            {allowKeep ? `Delete from ${d} & sign out` : count === 1 ? "Sign out and delete it" : "Sign out and delete them"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy} className="min-h-11 w-full">
            {allowKeep ? "Stay signed in" : "Cancel"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
