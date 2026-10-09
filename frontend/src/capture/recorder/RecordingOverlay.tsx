import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { PlatformContext } from "@/lib/platform";
import { PhoneRecorder } from "./final/PhoneRecorder";
import { recorderFinalEnabled } from "./final/recorderFinalFlag";
import {
  recorderLayout,
  shellForPlatform,
  type RecorderLayout,
} from "./final/shellCapabilities";
import { overlayMount } from "./overlayMount";
import { RecordingView, type RecordingViewProps } from "./RecordingView";
import { useRecorder } from "./RecorderProvider";

// Only the flag-on desktop branch renders this, so a flag-off build never fetches it.
const DesktopRecorder = lazy(() =>
  import("./final/desktop/DesktopRecorder").then((module) => ({
    default: module.DesktopRecorder,
  })),
);

function useRecorderLayout(): RecorderLayout {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return recorderLayout(width);
}

/** The ring view fills the main region, so a move to another screen puts it away: the dock takes over. */
function MinimizeOnNavigate() {
  const recorder = useRecorder();
  const { key } = useLocation();
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    void recorder.minimiseSheet();
  }, [key, recorder]);
  return null;
}

export type RecordingOverlayProps = Omit<RecordingViewProps, "recorder"> & {
  /** The app's main region (AppShell's recorder host), where the desktop view is drawn. */
  desktopHost?: HTMLElement | null;
  /** Opens the note view from the desktop view's Write notes / View notes. */
  onOpenNotes?: () => void;
  /** Whether the Soft skin is on. The flag decides unless the caller is the final shell, which only renders with it on (the browser harness builds with no env). */
  finalSkin?: boolean;
};

export function RecordingOverlay({
  desktopHost = null,
  onOpenNotes,
  finalSkin = recorderFinalEnabled(),
  ...props
}: RecordingOverlayProps) {
  const recorder = useRecorder();
  const layout = useRecorderLayout();
  const shell = shellForPlatform(useContext(PlatformContext));
  const mount = overlayMount({
    flag: finalSkin,
    shell,
    layout,
    available: recorder.available,
    receipt: recorder.phase === "idle" && recorder.outcome !== null,
  });

  if (mount === "desktop" && layout !== "phone") {
    if (!recorder.sheetOpen || !desktopHost) return null;
    return createPortal(
      <>
        <MinimizeOnNavigate />
        <Suspense fallback={null}>
          <DesktopRecorder layout={layout} onOpenNotes={onOpenNotes} />
        </Suspense>
      </>,
      desktopHost,
    );
  }

  const final = mount === "phone";
  return (
    <DialogPrimitive.Root
      open={recorder.sheetOpen}
      onOpenChange={(open) => {
        if (!open) recorder.minimiseSheet();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-overlay-open="true"
          data-testid="recording-overlay"
          className="fixed inset-0 z-50 h-dvh w-screen overflow-hidden bg-background outline-none"
          onEscapeKeyDown={(event) => {
            if (final) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Voice note recorder
          </DialogPrimitive.Title>
          {final ? (
            <PhoneRecorder />
          ) : (
            <RecordingView recorder={recorder} {...props} />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
