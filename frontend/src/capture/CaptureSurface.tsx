// Capture (TC-761): the first of Exo's three destinations, and the phone app's
// landing. It gathers the capture tools that used to live in Connectors, as
// they are, until the new Capture home replaces them (PR4, PR6, PR7):
//
//   the Voice notes card (phone app), mounted only while Capture shows, so it
//     never coexists with the chat screen's voice note bar (one recorder view);
//   the Transcriber card (Upload audio, the meeting notetaker, desktop Local
//     recording), kept mounted while hidden so a local recording survives
//     navigation; its reads pause while it is off screen;
//   the Library (/chat/capture/library), kept mounted and hidden beside the
//     home, re-listing when it is entered and when something new lands.
//
// Fixed tree: the home pane and the Library pane are always both rendered, and
// only `hidden` moves between them. Each is its own scroller, so each keeps
// its scroll.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { uploadRunner } from "@/lib/audioUpload";
import { scheduledSpace } from "@/lib/spaceQueue";
import { LibraryPage } from "@/chat/LibraryPage";
import { TranscriberSection } from "@/chat/TranscriberSection";
import { useTranscriberSavedState } from "@/chat/useTranscriberLibrarySync";
import { VoiceNotesSection } from "@/chat/VoiceNotesSection";
import { useNavKind } from "@/shell/navItems";
import { goUp } from "@/shell/navigation";
import { PAGE_COLUMN, PageHeader, SettingsGear } from "@/shell/PageHeader";
import { PATHS, type Screen } from "@/shell/routes";
import { captureEvents } from "./captureEvents";

export interface CaptureSurfaceProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** Capture is the destination on screen (it stays mounted, hidden, otherwise). */
  active: boolean;
  /** Which Capture screen: home, or the Library (a note shows the Library until note detail lands). */
  screen: Screen;
  /** The cohort meetings section App owns (MeetingsSection), shown in the Library. */
  meetingsSlot?: React.ReactNode;
}

const emitLibraryChanged = () => captureEvents.emit("library-changed");

const PANE = "relative h-full overflow-y-auto";

export function CaptureSurface({ tcw, backendUrl, sessionStore, active, screen, meetingsSlot }: CaptureSurfaceProps) {
  const navigate = useNavigate();
  const nav = useNavKind();
  const libraryShown = screen.id === "library" || screen.id === "note";
  const homeShown = active && !libraryShown;

  // The Library re-lists when it is entered (not on the first mount, which
  // lists anyway) and when something lands while it is open.
  const [listSignal, setListSignal] = useState(0);
  const libraryOpen = active && libraryShown;
  const wasOpen = useRef(libraryOpen);
  const openRef = useRef(libraryOpen);
  openRef.current = libraryOpen;
  useEffect(() => {
    if (libraryOpen && !wasOpen.current) setListSignal((n) => n + 1);
    wasOpen.current = libraryOpen;
  }, [libraryOpen]);
  useEffect(
    () =>
      captureEvents.on("library-changed", () => {
        if (openRef.current) setListSignal((n) => n + 1);
      }),
    [],
  );

  // Something lands: an upload's transcript is saved, or a notetaker's
  // transcript is copied into the space (the saved count rises).
  const upload = useSyncExternalStore(uploadRunner.subscribe, uploadRunner.snapshot, uploadRunner.snapshot);
  const uploadStage = upload?.stage ?? null;
  const lastStage = useRef(uploadStage);
  useEffect(() => {
    if (uploadStage === "saved" && lastStage.current !== "saved") emitLibraryChanged();
    lastStage.current = uploadStage;
  }, [uploadStage]);
  const savedState = useTranscriberSavedState();
  const savedCount = Object.values(savedState).filter((state) => state === "saved").length;
  const lastSavedCount = useRef(savedCount);
  useEffect(() => {
    if (savedCount > lastSavedCount.current) emitLibraryChanged();
    lastSavedCount.current = savedCount;
  }, [savedCount]);

  return (
    <div className="relative h-full" data-testid="capture-surface">
      <div className={libraryShown ? "hidden" : PANE} data-scroll-root data-testid="capture-home">
        <PageHeader
          title="Capture"
          className={PAGE_COLUMN}
          trailing={
            <>
              <Link
                to={PATHS.library}
                className="tap-transparent flex h-11 items-center rounded-full px-3 text-callout font-medium text-primary transition-colors hover:bg-surface-2 active:bg-surface-2"
              >
                Library
              </Link>
              {nav === "tabbar" && <SettingsGear />}
            </>
          }
        />
        <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2`}>
          {active && (
            <VoiceNotesSection tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} onSaved={emitLibraryChanged} />
          )}
          <TranscriberSection backendUrl={backendUrl} sessionStore={sessionStore} tcw={tcw} active={homeShown} />
        </div>
      </div>
      <div className={libraryShown ? PANE : "hidden"} data-scroll-root data-testid="capture-library">
        <PageHeader title="Library" back={() => goUp(navigate, PATHS.capture)} className={PAGE_COLUMN} />
        <div className={`${PAGE_COLUMN} pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2`}>
          <LibraryPage tcw={scheduledSpace(tcw)} meetingsSlot={meetingsSlot} listSignal={listSignal} />
        </div>
      </div>
    </div>
  );
}
