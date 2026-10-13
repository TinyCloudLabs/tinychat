// Capture (TC-761): the first of Exo's three destinations, and the phone app's
// landing. It gathers the capture tools that used to live in Connectors:
//
//   In progress: the upload, the notetaker sessions still moving, and the
//     voice notes still only on this phone (or stopped at the limit);
//   Recent (a phone): the last five captures, with See all;
//   the actions: Upload and Meeting open their sheets; Record goes through
//     the one recorder (RecorderProvider). The notetaker's state
//     comes from one useMeetingBot, here, for both the sheet and the rows; its
//     reads and polling run only while the home shows;
//   the Library (/chat/capture/library) and a note (/chat/capture/library/:id),
//     read by one useLibrary, here, for Recent, the list and the note.
//
// Fixed tree: [list pane: [home][Library]] [detail pane], always all rendered;
// only classes move. On a phone (compact) one of home, Library or the note
// shows, each its own scroller, so each keeps its scroll. From medium up the
// list pane (home above the Library) sits beside the detail pane. A resize
// never re-parents anything: the cohort archive keeps its place.
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { uploadRunner } from "@/lib/audioUpload";
import { PlatformContext } from "@/lib/platform";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { activeMeetings, useMeetingBot } from "@/chat/TranscriberSection";
import { useNavKind } from "@/shell/navItems";
import { goUp } from "@/shell/navigation";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { PATHS, type Screen } from "@/shell/routes";
import { FirstUse } from "./FirstUse";
import { HOME_COPY } from "./home/homeCopy";
import { SoftActions } from "./home/SoftActions";
import { SoftCaptureHome } from "./home/SoftCaptureHome";
import { captureHomeKind, layoutForNav } from "./home/desktop/captureHomeKind";
import { LazyDesktopCaptureHome } from "./home/desktop/LazyDesktopCaptureHome";
import { SoftHomeProvider } from "./home/softHome";
import { useSoftTheme } from "./home/softTheme";
import { inProgressShown, type InProgressRowsViewProps } from "./InProgressRows";
import { LibraryScreen } from "./library/LibraryScreen";
import { NoteDetail } from "./library/NoteDetail";
import { RecentNotePendingSheet } from "./library/RecentNotePendingSheet";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { useLibrary } from "./library/useLibrary";
import { combinedModel, useNotePipelines, type NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { listPipelineEntries } from "./listPipelineEntries";
import { pipelineActionPriority, type PipelineActionKind } from "@/lib/voiceNotes/notePipeline";
import { onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { MeetingSheet } from "./meeting/MeetingSheet";
import { useRecorder } from "./recorder/RecorderProvider";
import { continuePausedUpload, pausedUpload } from "./upload/pausedUpload";
import { UploadSheet } from "./upload/UploadSheet";
import { useUploadDeps } from "./upload/useUploadDeps";
import { ActivityPanel } from "./activity/ActivityPanel";
import type { NotePipelineSource } from "@/lib/voiceNotes/useNotePipeline";

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

const SCROLLER = "relative h-full overflow-y-auto";
/** The list pane's gutters beside the detail pane. */
const LIST_COLUMN = "w-full px-4";

type Sheet = "upload" | "meeting";

/** Keep progress subscriptions below the surface so capture chrome updates at most four times a second. */
function PipelineBridge({ entries, onViews }: { entries: readonly { id: string; source: NotePipelineSource }[]; onViews: (views: ReadonlyMap<string, NotePipelineView>) => void }) {
  const views = useNotePipelines(entries);
  const latest = useRef(views);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    latest.current = views;
    if (timer.current === null) timer.current = setTimeout(() => { timer.current = null; onViews(latest.current); }, 250);
  }, [views, onViews]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return null;
}

export function CaptureSurface(props: CaptureSurfaceProps) {
  // A compact width has the Soft home (TC-862); medium and up has the desktop home.
  const size = useSizeClass().size;
  const recorder = useRecorder();
  const kind = captureHomeKind(size);
  const soft = kind === "phone";
  return (
    <SoftHomeProvider enabled={soft} issues={recorder.captureIssues} onDismissIssue={recorder.dismissCaptureIssue}>
      <CaptureSurfaceBody {...props} soft={soft} desktopHome={kind === "desktop"} />
    </SoftHomeProvider>
  );
}

function CaptureSurfaceBody({ tcw, backendUrl, sessionStore, active, screen, meetingsSlot, soft, desktopHome }: CaptureSurfaceProps & { soft: boolean; desktopHome: boolean }) {
  const navigate = useNavigate();
  const openActivityNote = useCallback((id: string) => navigate(PATHS.library + "/" + id), [navigate]);
  const location = useLocation();
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
  const upload = useSyncExternalStore(uploadRunner.subscribe, uploadRunner.snapshot, uploadRunner.snapshot);

  // The notetaker: one per app, for the Meeting sheet and the In progress rows.
  const bot = useMeetingBot({ backendUrl, sessionStore, active: homeShown });
  const paused = useSyncExternalStore(pausedUpload.subscribe, pausedUpload.snapshot, pausedUpload.snapshot);
  const { deps: uploadDeps } = useUploadDeps(tcw, backendUrl, sessionStore);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [recentNoteId, setRecentNoteId] = useState<string | null>(null);
  useEffect(() => {
    const fromHistory = (location.state as { recentNoteSheet?: unknown } | null)?.recentNoteSheet;
    setRecentNoteId(typeof fromHistory === "string" ? fromHistory : null);
  }, [location.key, location.state]);
  useEffect(() => {
    if (!active || screen.id !== "capture") setRecentNoteId(null);
  }, [active, screen.id]);
  // A sheet belongs to the home: leaving it (another destination, the
  // Library, a How it works link) closes it.
  useEffect(() => {
    if (!homeShown) setSheet(null);
  }, [homeShown]);
  const sheetChange = (which: Sheet) => (open: boolean) => setSheet(open ? which : null);
  const openRecentNote = (id: string) => {
    setRecentNoteId(id);
    navigate(location.pathname, { state: { recentNoteSheet: id } });
  };
  const closeRecentNote = () => {
    if ((location.state as { recentNoteSheet?: unknown } | null)?.recentNoteSheet === recentNoteId) navigate(-1);
    else setRecentNoteId(null);
  };
  // The phone app's recorder: notes still on this phone and a stop at the limit are In progress rows.
  const recorder = useRecorder();
  // Static screen fixtures predate account-scoped pending snapshots; the live store always sets this field.
  const pendingVisible = recorder.pending.accountDid === undefined || recorder.pending.accountDid === tcw.did;

  // Recent, the Library and the open note: one reader, through the per-space queue.
  const library = useLibrary(tcw, {
    visible: active,
    noteId: screen.noteId ?? recentNoteId,
    onPhone: pendingVisible ? (recorder.pending.notes ?? null) : null,
  });
  const pipelineEntries = useMemo(() => listPipelineEntries(library.items, tcw), [library.items, tcw]);
  const [activityViews, setActivityViews] = useState<ReadonlyMap<string, NotePipelineView>>(() => new Map());
  const pipelines = useMemo(() => new Map([...activityViews].map(([id, view]) => [id, view.pipeline])), [activityViews]);
  const actionTarget = useMemo(() => {
    let selected: { id: string; view: NotePipelineView; priority: number } | null = null;
    for (const entry of pipelineEntries) {
      const view = activityViews.get(entry.id);
      const pipeline = view?.pipeline;
      const kind = pipeline?.blocker?.action?.kind;
      const priority = pipelineActionPriority(kind);
      if (view && kind && (!selected || priority > selected.priority)) selected = { id: entry.id, view, priority };
    }
    return selected;
  }, [pipelineEntries, activityViews]);
  const modelStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const model = combinedModel(modelStatus);
  const modelProgress = model === null ? null : { bytes: model.bytes, totalBytes: model.totalBytes };
  // A saved voice note is the note itself: a full page (desktop) or a sheet over the Library (phone).
  const openNote = (noteScreen || recentNoteId !== null) && library.note.item?.source === VOICE_NOTE_SOURCE ? library.note.item : null;
  const notePage = desktopHome && noteScreen && openNote !== null;
  const noteSheet = soft && openNote !== null;
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
          listing: pendingVisible ? recorder.pending.listing : { state: "unknown" },
          saving: pendingVisible && recorder.pending.running,
          online: pendingVisible && recorder.pending.online,
          pendingNotes: pendingVisible ? recorder.pending.notes ?? [] : [],
          lastError: pendingVisible ? recorder.pending.lastError : null,
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
  const sidebarActivity = platform === "tauri" && nav === "sidebar";
  const activityControl = <ActivityPanel items={library.items} views={activityViews} platform={platform} onOpenNote={openActivityNote}
    upload={upload} paused={paused} onOpenUpload={() => setSheet("upload")} onContinueUpload={() => continuePausedUpload(uploadDeps)}
    onRetryUpload={() => uploadRunner.retry(uploadDeps)} active={active} placement={sidebarActivity ? "sidebar" : "inline"} />;

  return (
    <div
      className={wide && !homeOnly && !notePage ? "grid h-full grid-cols-[minmax(0,22.5rem)_minmax(0,1fr)]" : "relative h-full"}
      data-testid="capture-surface"
      data-layout={wide ? "panes" : "stack"}
    >
      <PipelineBridge entries={pipelineEntries} onViews={setActivityViews} />
      {sidebarActivity && activityControl}
      <div
        className={cn(
          homeOnly ? "relative h-full" : notePage ? "hidden" : wide ? `${SCROLLER} border-r border-border` : noteScreen && !noteSheet ? "hidden" : "relative h-full",
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
              activityControl={sidebarActivity ? undefined : activityControl}
            />
          ) : (
            <>
          <PageHeader
            title="Capture"
            className={column}
            trailing={
              <div className="flex flex-wrap items-center gap-2">{!sidebarActivity && activityControl}<Link to={PATHS.library} className="soft-header-link">
                {HOME_COPY.library}
              </Link></div>
            }
          />
          <div className={cn(column, "flex flex-1 flex-col gap-6 pt-2 pb-4")}>
            <SoftCaptureHome
              inProgress={inProgress}
              recent={{ status: library.status, items: library.items }}
              scanFailure={recorder.recoveryScanFailure}
              onRetryRecent={library.retry}
              onOpenRecentNote={openRecentNote}
              pipelines={pipelines}
              pipelineNotes={library.items}
              modelProgress={modelProgress}
              pipelineActionError={actionTarget?.view.actionError}
              onPipelineAction={(kind: PipelineActionKind, id: string) => activityViews.get(id)?.onAction(kind)}
              onOpenLibrary={() => navigate(PATHS.library)}
              now={now}
            />
          </div>
          <div className="sticky bottom-0 z-10 bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
            <div className={column}>
              <SoftActions
                onUpload={() => setSheet("upload")}
                {...(bot.listStatus === "dark" ? {} : { onMeeting: () => setSheet("meeting") })}
              />
            </div>
          </div>
            </>
          )}
        </div>
        <div
          ref={libraryRef}
          className={homeOnly ? "hidden" : desktopHome ? SCROLLER : wide ? "border-t border-border pt-2" : libraryScreen || (noteSheet && recentNoteId === null) ? SCROLLER : "hidden"}
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
            pipelines={pipelines}
            activityViews={activityViews}
            platform={platform}
            activityControl={!sidebarActivity && libraryScreen ? activityControl : undefined}
          />
        </div>
      </div>
      <div
        className={homeOnly || noteSheet || (soft && recentNoteId !== null) ? "hidden" : notePage ? "h-full overflow-hidden" : wide || noteScreen ? SCROLLER : "hidden"}
        data-scroll-root=""
        data-testid="capture-detail"
      >
        {noteScreen || (recentNoteId !== null && openNote !== null) ? (
          <NoteDetail
            key={screen.noteId ?? recentNoteId}
            library={library}
            pushed={!wide}
            onBack={() => {
              if (recentNoteId !== null) closeRecentNote();
              else goUp(navigate, notePage ? PATHS.capture : PATHS.library);
            }}
            transcription={recorder.transcription}
            activityView={openNote ? activityViews.get(openNote.sourceId) : undefined}
            platform={platform}
            activityControl={!sidebarActivity && noteScreen ? activityControl : undefined}
            savedNote={notePage || noteSheet ? { tcw, layout: notePage ? "page" : "sheet" } : undefined}
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
      {soft && recentNoteId !== null && !openNote && (
        <RecentNotePendingSheet listing={library.listing} failed={library.status === "failed"} onRetry={library.retry} onClose={closeRecentNote} suspended={recorder.sheetOpen} />
      )}
    </div>
  );
}
