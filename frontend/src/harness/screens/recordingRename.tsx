// Renaming a recording from the Home and Library rows and from the note header (TC-2195), over a writable fixture
// space. Driven by a test, not captured.
import { useContext, useMemo } from "react";

import { PlatformContext } from "@/lib/platform";
import { renameSpaceTcw } from "../fixtures/renameSpace";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";

function RenameShell() {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const tcw = useMemo(() => renameSpaceTcw(), []);
  return <ShellApp platform={platform} shim={shim} state="ready" captureTcw={tcw} recorder={{ available: true, ready: true }} />;
}

const BASE = { group: "recordingRename", layout: "pane", displayTitle: true, interactive: true, render: () => <RenameShell /> } as const;

export const recordingRenameScreens: HarnessScreen[] = [
  { ...BASE, id: "recording-rename-home", path: "/chat/capture", platform: "ios", readyWhen: '[data-testid="recording-rename"]' },
  { ...BASE, id: "recording-rename-library", path: "/chat/capture/library", platform: "ios", readyWhen: '[data-testid="library-list"][data-state="ready"] [data-testid="recording-rename"]' },
  { ...BASE, id: "recording-rename-note", path: "/chat/capture/library/note-transcribed", platform: "ios", readyWhen: '[data-testid="recording-rename"]' },
  { ...BASE, id: "recording-rename-library-web", path: "/chat/capture/library", platform: "web", readyWhen: '[data-testid="library-list"][data-state="ready"] [data-testid="recording-rename"]' },
  { ...BASE, id: "recording-rename-note-web", path: "/chat/capture/library/note-transcribed", platform: "web", readyWhen: '[data-testid="recording-rename"]' },
];
