// Capture (TC-761): the first of Exo's three destinations, and the phone app's
// landing. It gathers the capture tools that used to live in Connectors:
//
//   Record on this Mac (desktop app), at the top, in a fixed place in the
//     tree: Capture stays mounted while hidden, so a local recording survives
//     navigation;
//   the Voice notes list (phone app), mounted only while Capture shows, so its
//     reads never run off screen;
//   In progress: the upload, the notetaker sessions still moving, and the
//     voice notes still only on this phone (or stopped at the limit);
//   the actions: Upload and Meeting open their sheets; Record (phone app)
//     goes through the one recorder (RecorderProvider). The notetaker's state
//     comes from one useMeetingBot, here, for both the sheet and the rows; its
//     reads and polling run only while the home shows;
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
import { isDesktopLocalTranscriptionAvailable } from "@/lib/localTranscriber";
import { scheduledSpace } from "@/lib/spaceQueue";
import { LibraryPage } from "@/chat/LibraryPage";
import { activeMeetings, useMeetingBot } from "@/chat/TranscriberSection";
import { useTranscriberSavedState } from "@/chat/useTranscriberLibrarySync";
import { VoiceNotesListCard } from "@/chat/VoiceNotesListCard";
import { useNavKind } from "@/shell/navItems";
import { goUp } from "@/shell/navigation";
import { PAGE_COLUMN, PageHeader, SettingsGear } from "@/shell/PageHeader";
import { PATHS, type Screen } from "@/shell/routes";
import { CaptureActions } from "./CaptureActions";
import { captureEvents } from "./captureEvents";
import { LocalRecorderCard } from "./desktop/LocalRecorderCard";
import { InProgressRowsView } from "./InProgressRows";
import { MeetingSheet } from "./meeting/MeetingSheet";
import { RecordButton } from "./recorder/RecordButton";
import { useRecorder } from "./recorder/RecorderProvider";
import { continuePausedUpload, pausedUpload } from "./upload/pausedUpload";
import { UploadSheet } from "./upload/UploadSheet";
import { useUploadDeps } from "./upload/useUploadDeps";

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

type Sheet = "upload" | "meeting";

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

  // The notetaker: one per app, for the Meeting sheet and the In progress rows.
  const bot = useMeetingBot({ backendUrl, sessionStore, active: homeShown });
  const paused = useSyncExternalStore(pausedUpload.subscribe, pausedUpload.snapshot, pausedUpload.snapshot);
  const { deps: uploadDeps } = useUploadDeps(tcw, backendUrl, sessionStore);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // A sheet belongs to the home: leaving it (another destination, the
  // Library, a How it works link) closes it.
  useEffect(() => {
    if (!homeShown) setSheet(null);
  }, [homeShown]);
  const sheetChange = (which: Sheet) => (open: boolean) => setSheet(open ? which : null);
  const localRecorder = isDesktopLocalTranscriptionAvailable();
  // The phone app's recorder: notes still on this phone and a stop at the limit are In progress rows.
  const recorder = useRecorder();

  return (
    <div className="relative h-full" data-testid="capture-surface">
      <div className={libraryShown ? "hidden" : `${PANE} flex flex-col`} data-scroll-root data-testid="capture-home">
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
        <div className={`${PAGE_COLUMN} flex flex-1 flex-col gap-6 pb-4 pt-2`}>
          {localRecorder && <LocalRecorderCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />}
          <InProgressRowsView
            upload={upload}
            paused={paused}
            meetings={activeMeetings(bot.meetings)}
            busyId={bot.busyId}
            voice={
              recorder.available
                ? {
                    pendingCount: recorder.pending.count,
                    saving: recorder.pending.running,
                    lastError: recorder.pending.lastError,
                    limitNotice: recorder.phase === "recording" ? null : recorder.limitNotice,
                    onSaveNow: recorder.retryPending,
                  }
                : undefined
            }
            onOpenUpload={() => setSheet("upload")}
            onContinue={() => continuePausedUpload(uploadDeps)}
            onOpenMeeting={() => setSheet("meeting")}
            onEnd={bot.actions.stop}
          />
          {active && <VoiceNotesListCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />}
        </div>
        <div className="sticky bottom-0 z-10 bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
          <CaptureActions
            className={PAGE_COLUMN}
            record={<RecordButton variant="action" />}
            onUpload={() => setSheet("upload")}
            {...(bot.listStatus === "dark" ? {} : { onMeeting: () => setSheet("meeting") })}
          />
        </div>
      </div>
      <div className={libraryShown ? PANE : "hidden"} data-scroll-root data-testid="capture-library">
        <PageHeader title="Library" back={() => goUp(navigate, PATHS.capture)} className={PAGE_COLUMN} />
        <div className={`${PAGE_COLUMN} pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2`}>
          <LibraryPage tcw={scheduledSpace(tcw)} meetingsSlot={meetingsSlot} listSignal={listSignal} />
        </div>
      </div>
      <UploadSheet open={sheet === "upload"} onOpenChange={sheetChange("upload")} tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />
      <MeetingSheet open={sheet === "meeting"} onOpenChange={sheetChange("meeting")} bot={bot} />
    </div>
  );
}
