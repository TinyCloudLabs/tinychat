// The app's shell with the recorder's presentations in their slots (TC-761,
// PR4): the island above the tab bar on a phone held upright, the live button
// in the rail, the live card in the sidebar, and the recorder sheet. App and
// the browser harnesses render this inside the one RecorderProvider.
import { useNavKind } from "@/shell/navItems";
import { AppShell, type AppShellProps } from "@/shell/AppShell";
import { Island } from "./Island";
import { RailLiveButton } from "./RailLiveButton";
import { islandShown, useRecorder } from "./RecorderProvider";
import { RecorderSheet } from "./RecorderSheet";
import { SidebarLiveCard } from "./SidebarLiveCard";

export function RecorderShell({ onOpenNote, ...shell }: Omit<AppShellProps, "island" | "railLive" | "sidebarLive"> & {
  /** Opens a saved note (the receipt's and the island's Open). */
  onOpenNote?: (id: string) => void;
}) {
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
      <RecorderSheet onOpenNote={onOpenNote} />
    </>
  );
}
