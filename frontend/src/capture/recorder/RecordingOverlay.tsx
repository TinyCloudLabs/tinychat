import { useContext, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { PlatformContext } from "@/lib/platform";
import { PhoneRecorder } from "./final/PhoneRecorder";
import { recorderFinalEnabled } from "./final/recorderFinalFlag";
import { recorderLayout, shellForPlatform } from "./final/shellCapabilities";
import { RecordingView, type RecordingViewProps } from "./RecordingView";
import { useRecorder } from "./RecorderProvider";

function usePhoneLayout(): boolean {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return recorderLayout(width) === "phone";
}

export function RecordingOverlay(props: Omit<RecordingViewProps, "recorder">) {
  const recorder = useRecorder();
  const phoneLayout = usePhoneLayout();
  const phone = shellForPlatform(useContext(PlatformContext)) === "phone";
  // A receipt (Done, then saved) keeps today's view until the Soft skin reaches it.
  const final = recorderFinalEnabled() && phone && phoneLayout && !(recorder.phase === "idle" && recorder.outcome !== null);
  return (
    <DialogPrimitive.Root open={recorder.sheetOpen} onOpenChange={(open) => { if (!open) recorder.minimiseSheet(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-overlay-open="true"
          data-testid="recording-overlay"
          className="fixed inset-0 z-50 h-dvh w-screen overflow-hidden bg-background outline-none"
          onEscapeKeyDown={(event) => { if (final) event.preventDefault(); }}
          onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}
        >
          <DialogPrimitive.Title className="sr-only">Voice note recorder</DialogPrimitive.Title>
          {final ? <PhoneRecorder /> : <RecordingView recorder={recorder} {...props} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
