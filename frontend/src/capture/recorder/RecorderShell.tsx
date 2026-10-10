// The app's shell with the recorder's presentations in their slots: the Ribbon
// above the tab bar on a phone held upright, floating on the rail, the dock in
// the sidebar, and the full-page recorder. App and the browser harnesses render
// this inside the one RecorderProvider.
import { useState } from "react";
import { useNavKind } from "@/shell/navItems";
import { AppShell, type AppShellProps } from "@/shell/AppShell";
import { MinimizedAlert } from "./final/MinimizedAlert";
import { MinimizedProvider } from "./final/MinimizedProvider";
import { showsMinimizedError } from "./final/minimizedView";
import { useNotesLifecycle } from "./final/notes/notesLifecycle";
import { FloatingRibbon, Ribbon } from "./final/Ribbon";
import { ShellChrome } from "./final/shell/ShellChrome";
import { SidebarDock } from "./final/SidebarDock";
import { ShellNoteNotice, useShellNoteNotice } from "./final/UnsavedNoteNotice";
import { Island, islandState } from "./Island";
import { RailLiveButton } from "./RailLiveButton";
import { islandShown, useRecorder } from "./RecorderProvider";
import { RecordingOverlay } from "./RecordingOverlay";
import { SidebarLiveCard } from "./SidebarLiveCard";

type RecorderShellProps = Omit<AppShellProps, "island" | "railLive" | "sidebarLive"> & {
  /** Opens a saved note (the receipt's and the island's Open). */
  onOpenNote?: (id: string) => void;
};

/**
 * The Soft-skin recorder minimised (TC-870): a Ribbon above the tab bar, the
 * same Ribbon floating on the rail, a dock in the sidebar. They stand in for
 * the island, the rail button and the sidebar card while recording; once it
 * stops, those keep showing the saving, saved and "Save now" states.
 */
export function RecorderShell({ onOpenNote, ...shell }: RecorderShellProps) {
  const recorder = useRecorder();
  // Mounted here because this shell outlives the recorder views: minimising or stopping while minimised still ends the notes UI state.
  useNotesLifecycle();
  const navKind = useNavKind();
  const [recorderHost, setRecorderHost] = useState<HTMLElement | null>(null);
  const minimized = islandShown(recorder);
  const recording = islandState(recorder) === "live";
  let island = null;
  if (minimized && navKind === "tabbar") {
    island = recording ? (
      <div className="px-[14px] py-1">
        <MinimizedAlert />
        <Ribbon />
      </div>
    ) : (
      <div className="px-3 py-1">
        <MinimizedAlert />
        <Island onOpenNote={onOpenNote} />
      </div>
    );
  } else if (minimized && navKind === "rail" && (recording || showsMinimizedError(recorder))) {
    island = <FloatingRibbon ribbon={recording} />;
  }
  const noteNotice = useShellNoteNotice();
  if (noteNotice && navKind === "tabbar") {
    island = (
      <>
        <ShellNoteNotice layout="tabbar" />
        {island}
      </>
    );
  }
  const dock = minimized && recording ? <SidebarDock /> : null;
  const sidebarCard = recording ? dock : <SidebarLiveCard />;
  const sidebarAlert = minimized && showsMinimizedError(recorder);
  return (
    <MinimizedProvider>
      <ShellChrome />
      <AppShell
        {...shell}
        island={island}
        recorderHost={setRecorderHost}
        railLive={recording ? null : <RailLiveButton />}
        sidebarLive={
          sidebarAlert || sidebarCard ? (
            <>
              {sidebarAlert ? <MinimizedAlert layout="desktop" /> : null}
              {sidebarCard}
            </>
          ) : null
        }
      />
      {navKind === "tabbar" ? null : <ShellNoteNotice layout="beside" />}
      <RecordingOverlay onOpenNote={onOpenNote} desktopHost={recorderHost} />
    </MinimizedProvider>
  );
}
