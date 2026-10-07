import * as DialogPrimitive from "@radix-ui/react-dialog";

import { RecordingView, type RecordingViewProps } from "./RecordingView";
import { useRecorder } from "./RecorderProvider";

export function RecordingOverlay(props: Omit<RecordingViewProps, "recorder">) {
  const recorder = useRecorder();
  return (
    <DialogPrimitive.Root open={recorder.sheetOpen} onOpenChange={(open) => { if (!open) recorder.minimiseSheet(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-overlay-open="true"
          data-testid="recording-overlay"
          className="fixed inset-0 z-50 h-dvh w-screen overflow-hidden bg-background outline-none"
          onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}
        >
          <DialogPrimitive.Title className="sr-only">Voice note recorder</DialogPrimitive.Title>
          <RecordingView recorder={recorder} {...props} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
