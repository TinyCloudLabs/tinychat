import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { PlatformContext } from "@/lib/platform";
import { DesktopRecorderHost } from "./final/desktop/DesktopRecorderHost";
import type { DesktopRecorderLoader } from "./final/desktop/LazyDesktopRecorder";
import type { NoteViewLoader } from "./final/desktop/LazyNoteView";
import {
  LazyPhoneRecorder,
  type PhoneRecorderLoader,
} from "./final/LazyPhoneRecorder";
import { recorderFinalEnabled } from "./final/recorderFinalFlag";
import {
  recorderLayout,
  shellForPlatform,
  type RecorderLayout,
} from "./final/shellCapabilities";
import { ReceiptNoteNotice } from "./final/UnsavedNoteNotice";
import { overlayMount } from "./overlayMount";
import { RecordingView, type RecordingViewProps } from "./RecordingView";
import { useRecorder } from "./RecorderProvider";

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
  /** The app's main region (AppShell's recorder host), where the desktop view is drawn; null until it mounts. Left out above the gate, where there is no shell, so the classic dialog stays. */
  desktopHost?: HTMLElement | null;
  /** Whether the Soft skin is on. The flag decides unless the caller is the final shell, which only renders with it on (the browser harness builds with no env). */
  finalSkin?: boolean;
  /** Where the desktop view is imported from; a test replaces it. */
  loadDesktopRecorder?: DesktopRecorderLoader;
  /** Where the desktop note view is imported from; a test replaces it. */
  loadNoteView?: NoteViewLoader;
  /** Where the phone view is imported from; a test replaces it. */
  loadPhoneRecorder?: PhoneRecorderLoader;
};

export function RecordingOverlay({
  desktopHost,
  finalSkin = recorderFinalEnabled(),
  loadDesktopRecorder,
  loadNoteView,
  loadPhoneRecorder,
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
    hosted: desktopHost !== undefined,
    receipt: recorder.phase === "idle" && recorder.outcome !== null,
  });

  if (mount === "desktop" && layout !== "phone") {
    if (!recorder.sheetOpen || !desktopHost) return null;
    return createPortal(
      <>
        <MinimizeOnNavigate />
        <DesktopRecorderHost
          layout={layout}
          loadDesktopRecorder={loadDesktopRecorder}
          loadNoteView={loadNoteView}
        />
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
            <LazyPhoneRecorder load={loadPhoneRecorder} />
          ) : (
            <>
              <RecordingView recorder={recorder} {...props} />
              <ReceiptNoteNotice />
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
