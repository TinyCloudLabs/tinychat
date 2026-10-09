// The app's shell with the recorder's presentations in their slots (TC-761,
// PR4): the island above the tab bar on a phone held upright, the live button
// in the rail, the live card in the sidebar, and the full-page recorder. App and
// the browser harnesses render this inside the one RecorderProvider.
import { useState } from "react";
import { useNavKind } from "@/shell/navItems";
import { AppShell, type AppShellProps } from "@/shell/AppShell";
import { MinimizedAlert } from "./final/MinimizedAlert";
import { MinimizedProvider } from "./final/MinimizedProvider";
import { showsMinimizedError } from "./final/minimizedView";
import { recorderFinalEnabled } from "./final/recorderFinalFlag";
import { FloatingRibbon, Ribbon } from "./final/Ribbon";
import { SidebarDock } from "./final/SidebarDock";
import { Island, islandState } from "./Island";
import { RailLiveButton } from "./RailLiveButton";
import { islandShown, useRecorder } from "./RecorderProvider";
import { RecordingOverlay } from "./RecordingOverlay";
import { SidebarLiveCard } from "./SidebarLiveCard";

type RecorderShellProps = Omit<AppShellProps, "island" | "railLive" | "sidebarLive"> & {
  /** Opens a saved note (the receipt's and the island's Open). */
  onOpenNote?: (id: string) => void;
  /** Opens the note view from the desktop recorder's Write notes / View notes. */
  onOpenNotes?: () => void;
};

export function RecorderShell(props: RecorderShellProps) {
  return recorderFinalEnabled() ? <FinalRecorderShell {...props} /> : <ClassicRecorderShell {...props} />;
}

/**
 * The Soft-skin recorder minimised (TC-870): a Ribbon above the tab bar, the
 * same Ribbon floating on the rail, a dock in the sidebar. They stand in for
 * the island, the rail button and the sidebar card while recording; once it
 * stops, those keep showing the saving, saved and "Save now" states.
 */
export function FinalRecorderShell({ onOpenNote, onOpenNotes, ...shell }: RecorderShellProps) {
  const recorder = useRecorder();
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
  const dock = minimized && recording ? <SidebarDock /> : null;
  const sidebarCard = recording ? dock : <SidebarLiveCard />;
  const sidebarAlert = minimized && showsMinimizedError(recorder);
  return (
    <MinimizedProvider>
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
      <RecordingOverlay onOpenNote={onOpenNote} onOpenNotes={onOpenNotes} desktopHost={recorderHost} finalSkin />
    </MinimizedProvider>
  );
}

function ClassicRecorderShell({ onOpenNote, onOpenNotes: _onOpenNotes, ...shell }: RecorderShellProps) {
  const recorder = useRecorder();
  // On its side a phone has the rail, so nothing floats over Send.
  const tabbar = useNavKind() === "tabbar";
  return (
    <>
      <AppShell
        {...shell}
        island={
          tabbar && islandShown(recorder) ? (
            <div className="px-3 py-1">
              <Island onOpenNote={onOpenNote} />
            </div>
          ) : null
        }
        railLive={<RailLiveButton />}
        sidebarLive={<SidebarLiveCard />}
      />
      <RecordingOverlay onOpenNote={onOpenNote} />
    </>
  );
}
