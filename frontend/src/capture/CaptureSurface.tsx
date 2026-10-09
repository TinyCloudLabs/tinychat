// Capture (TC-761): the first of Exo's three destinations, and the phone app's
// landing. It gathers the capture tools that used to live in Connectors:
//
//   Record on this Mac (desktop app), at the top, in a fixed place in the
//     tree: Capture stays mounted while hidden, so a local recording survives
//     navigation;
//   In progress: the upload, the notetaker sessions still moving, and the
//     voice notes still only on this phone (or stopped at the limit);
//   Recent (a phone): the last five captures, with See all;
//   the actions: Upload and Meeting open their sheets; Record (phone app)
//     goes through the one recorder (RecorderProvider). The notetaker's state
//     comes from one useMeetingBot, here, for both the sheet and the rows; its
//     reads and polling run only while the home shows;
//   the Library (/chat/capture/library) and a note (/chat/capture/library/:id),
//     read by one useLibrary, here, for Recent, the list and the note.
//
// Fixed tree: [list pane: [home][Library]] [detail pane], always all rendered;
// only classes move. On a phone (compact) one of home, Library or the note
// shows, each its own scroller, so each keeps its scroll. From medium up the
// list pane (home above the Library) sits beside the detail pane. A resize
// never re-parents anything: the local recorder and the cohort archive keep
// their place.
import { useEffect, useRef, useState, useSyncExternalStore, useContext } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { uploadRunner } from "@/lib/audioUpload";
import { isDesktopLocalTranscriptionAvailable } from "@/lib/localTranscriber";
import { PlatformContext } from "@/lib/platform";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { activeMeetings, useMeetingBot } from "@/chat/TranscriberSection";
import { useTranscriberSavedState } from "@/chat/useTranscriberLibrarySync";
import { useNavKind } from "@/shell/navItems";
import { goUp } from "@/shell/navigation";
import { PAGE_COLUMN, PageHeader, SettingsGear } from "@/shell/PageHeader";
import { PATHS, type Screen } from "@/shell/routes";
import { CaptureActions } from "./CaptureActions";
import { CaptureHomeView, FirstUse } from "./CaptureHomeView";
import { captureEvents } from "./captureEvents";
import { LocalRecorderCard } from "./desktop/LocalRecorderCard";
import { HOME_COPY } from "./home/homeCopy";
import { SoftActions } from "./home/SoftActions";
import { SoftCaptureHome } from "./home/SoftCaptureHome";
import { captureHomeKind, layoutForNav } from "./home/desktop/captureHomeKind";
import { LazyDesktopCaptureHome } from "./home/desktop/LazyDesktopCaptureHome";
import { SoftHomeProvider, softHomeEnabled } from "./home/softHome";
import { useSoftTheme } from "./home/softTheme";
import { inProgressShown, type InProgressRowsViewProps } from "./InProgressRows";
import { LibraryScreen } from "./library/LibraryScreen";
import { NoteDetail } from "./library/NoteDetail";
import { useLibrary } from "./library/useLibrary";
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
  /** Which Capture screen: home, the Library, or a note. */
  screen: Screen;
  /** The cohort meetings section App owns (MeetingsSection), shown in the Library. */
  meetingsSlot?: React.ReactNode;
}

const emitLibraryChanged = () => captureEvents.emit("library-changed");

const SCROLLER = "relative h-full overflow-y-auto";
/** The list pane's gutters beside the detail pane. */
const LIST_COLUMN = "w-full px-4";

type Sheet = "upload" | "meeting";

export function CaptureSurface(props: CaptureSurfaceProps) {
  // Behind the flag: the phone (the tab bar, compact width) has the Soft home (TC-862);
  // a rail or sidebar at medium width and up, with a recorder, has the desktop home.
  const nav = useNavKind();
  const size = useSizeClass().size;
  const recorder = useRecorder();
  const kind = captureHomeKind({ flag: softHomeEnabled(), available: recorder.available, nav, size });
  const soft = kind === "phone";
  return (
    <SoftHomeProvider enabled={soft} issues={recorder.captureIssues} onDismissIssue={recorder.dismissCaptureIssue}>
      <CaptureSurfaceBody {...props} soft={soft} desktopHome={kind === "desktop"} />
    </SoftHomeProvider>
  );
}

function CaptureSurfaceBody({ tcw, backendUrl, sessionStore, active, screen, meetingsSlot, soft, desktopHome }: CaptureSurfaceProps & { soft: boolean; desktopHome: boolean }) {
  const navigate = useNavigate();
  const nav = useNavKind();
  const softTheme = useSoftTheme();
  const platform = useContext(PlatformContext);
  const wide = useSizeClass().size !== "compact";
  const libraryScreen = screen.id === "library";
  const noteScreen = screen.id === "note";
  // The desktop home fills the surface on its own; the Library and a note keep the two panes.
  const homeOnly = desktopHome && !libraryScreen && !noteScreen;
  // The home is on screen: always beside the Library (wide); on a phone, only on its own screen.
  const homeShown = active && (wide || (!libraryScreen && !noteScreen));
  const column = wide ? LIST_COLUMN : PAGE_COLUMN;

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

  // Recent, the Library and the open note: one reader, through the per-space queue.
  const library = useLibrary(tcw, {
    visible: active,
    noteId: screen.noteId,
    transcriber: recorder.available ? { backendUrl, sessionStore } : null,
  });
  const now = new Date();

  // Wide: the Library link and entering the Library bring its half of the list pane into view.
  const libraryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wide && active && libraryScreen) libraryRef.current?.scrollIntoView({ block: "start" });
  }, [wide, active, libraryScreen]);

  const inProgress: InProgressRowsViewProps = {
    upload,
    paused,
    meetings: activeMeetings(bot.meetings),
    busyId: bot.busyId,
    voice: recorder.available
      ? {
          listing: recorder.pending.listing,
          saving: recorder.pending.running,
          lastError: recorder.pending.lastError,
          limitNotice: recorder.phase === "recording" ? null : recorder.limitNotice,
          onSaveNow: recorder.retryPending,
        }
      : undefined,
    onOpenUpload: () => setSheet("upload"),
    onContinue: () => continuePausedUpload(uploadDeps),
    onOpenMeeting: () => setSheet("meeting"),
    onEnd: bot.actions.stop,
  };
  const empty = library.status === "ready" && library.items.length === 0 && !inProgressShown(inProgress);

  return (
    <div
      className={wide && !homeOnly ? "grid h-full grid-cols-[minmax(0,22.5rem)_minmax(0,1fr)]" : "relative h-full"}
      data-testid="capture-surface"
      data-layout={wide ? "panes" : "stack"}
    >
      <div
        className={cn(
          homeOnly ? "relative h-full" : wide ? `${SCROLLER} border-r border-border` : noteScreen ? "hidden" : "relative h-full",
          soft && `soft-skin soft-home ${softTheme}`,
        )}
        data-layout={soft ? "phone" : undefined}
        data-testid="capture-list-pane"
        data-scroll-root={wide ? "" : undefined}
      >
        <div
          className={homeOnly ? "h-full" : desktopHome ? "hidden" : wide ? "flex flex-col" : libraryScreen || noteScreen ? "hidden" : `${SCROLLER} flex flex-col`}
          data-scroll-root={wide || desktopHome ? undefined : ""}
          data-testid="capture-home"
        >
          {desktopHome ? (
            <LazyDesktopCaptureHome
              tcw={tcw}
              backendUrl={backendUrl}
              sessionStore={sessionStore}
              layout={layoutForNav(nav) === "rail" ? "rail" : "desktop"}
              inProgress={inProgress}
              recent={{ status: library.status, items: library.items }}
              onRetryRecent={library.retry}
              onUpload={() => setSheet("upload")}
              {...(bot.listStatus === "dark" ? {} : { onMeeting: () => setSheet("meeting") })}
              now={now}
            />
          ) : (
            <>
          <PageHeader
            title="Capture"
            className={column}
            trailing={
              <>
                {soft ? (
                  <Link to={PATHS.library} className="soft-header-link">
                    {HOME_COPY.library}
                  </Link>
                ) : (
                  <>
                    <Link
                      to={PATHS.library}
                      className="tap-transparent flex h-11 items-center rounded-full px-3 text-callout font-medium text-primary transition-colors hover:bg-surface-2 active:bg-surface-2"
                    >
                      Library
                    </Link>
                    {nav === "tabbar" && <SettingsGear />}
                  </>
                )}
              </>
            }
          />
          <div className={cn(column, "flex flex-1 flex-col gap-6 pt-2", wide ? "order-2 pb-6" : "pb-4")}>
            {localRecorder && <LocalRecorderCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />}
            {soft ? (
              <SoftCaptureHome
                inProgress={inProgress}
                recent={{ status: library.status, items: library.items }}
                scanFailure={recorder.recoveryScanFailure}
                onRetryRecent={library.retry}
                now={now}
              />
            ) : (
              <CaptureHomeView
                platform={platform}
                inProgress={inProgress}
                recent={wide ? null : { status: library.status, items: library.items }}
                onRetryRecent={library.retry}
                now={now}
              />
            )}
          </div>
          <div className={wide ? "order-1 pb-2 pt-1" : "sticky bottom-0 z-10 bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"}>
            {soft ? (
              <div className={column}>
                <SoftActions
                  onUpload={() => setSheet("upload")}
                  {...(bot.listStatus === "dark" ? {} : { onMeeting: () => setSheet("meeting") })}
                />
              </div>
            ) : (
              <CaptureActions
                // Beside the note the pane is narrow: with large text an action wraps rather than being cut.
                className={cn(column, wide && "flex-wrap")}
                record={<RecordButton variant="action" />}
                onUpload={() => setSheet("upload")}
                {...(bot.listStatus === "dark" ? {} : { onMeeting: () => setSheet("meeting") })}
              />
            )}
          </div>
            </>
          )}
        </div>
        <div
          ref={libraryRef}
          className={homeOnly ? "hidden" : desktopHome ? SCROLLER : wide ? "border-t border-border pt-2" : libraryScreen ? SCROLLER : "hidden"}
          data-scroll-root={wide ? undefined : ""}
          data-testid="capture-library"
        >
          <LibraryScreen
            library={library}
            meetingsSlot={meetingsSlot}
            pushed={!wide || desktopHome}
            onBack={() => goUp(navigate, PATHS.capture)}
            selectedId={wide ? screen.noteId : null}
            now={now}
            column={column}
          />
        </div>
      </div>
      <div
        className={homeOnly ? "hidden" : wide || noteScreen ? SCROLLER : "hidden"}
        data-scroll-root=""
        data-testid="capture-detail"
      >
        {noteScreen ? (
          <NoteDetail
            key={screen.noteId}
            library={library}
            pushed={!wide}
            onBack={() => goUp(navigate, PATHS.library)}
            transcription={recorder.transcription}
          />
        ) : wide ? (
          empty ? (
            <FirstUse platform={platform} className="px-6 pt-10 expanded:px-8" />
          ) : library.items.length > 0 ? (
            <p className="px-6 pt-10 text-callout text-muted-foreground expanded:px-8">Open a note to read it here.</p>
          ) : null
        ) : null}
      </div>
      <UploadSheet open={sheet === "upload"} onOpenChange={sheetChange("upload")} tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />
      <MeetingSheet open={sheet === "meeting"} onOpenChange={sheetChange("meeting")} bot={bot} />
    </div>
  );
}
