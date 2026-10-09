import { useContext, useMemo, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder } from "../../recorder/RecorderProvider";
import type { MeetingMetadataRead } from "@/lib/connectors/meetingExplorer";
import type { AudioLoad } from "../NoteDetailView";
import type { LibraryItem } from "../LibraryRow";
import { savedNoteMeta } from "./savedNoteMeta";
import { savedNoteStoreFor, type SavedNoteStore } from "./savedNoteStore";
import {
  SavedNotePage,
  SavedNoteSheet,
  type SavedNoteLayout,
} from "./SavedNoteView";
import { useSavedNoteScreen } from "./useSavedNoteScreen";

export interface SavedNoteProps {
  item: LibraryItem;
  metadata: MeetingMetadataRead | undefined;
  loadAudio: AudioLoad | null;
  tcw: TinyCloudWeb;
  /** Where the note is read and saved; the device's note store and the space. */
  store?: SavedNoteStore;
  layout: SavedNoteLayout;
  /** The page's ← Capture; the sheet's close. */
  onBack: () => void;
  transcript: ReactNode;
  footer?: ReactNode;
}

/** A saved voice note's note and its audio, as a page or a sheet. */
export default function SavedNote({
  item,
  metadata,
  loadAudio,
  tcw,
  store,
  layout,
  onBack,
  transcript,
  footer,
}: SavedNoteProps) {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const space = useMemo(() => store ?? savedNoteStoreFor(tcw), [store, tcw]);
  const screen = useSavedNoteScreen(item.sourceId, space);
  const view = {
    screen,
    layout,
    theme,
    id: item.id,
    title: item.title ?? "Untitled",
    meta: savedNoteMeta(
      item,
      metadata?.status === "ok" ? metadata.metadata : null,
      platform,
    ),
    loadAudio,
    transcript,
    footer,
    partialAudio:
      recorder.captureIssues[item.sourceId]?.kind === "partial_audio",
    onBack,
  } as const;
  return layout === "page" ? (
    <SavedNotePage {...view} />
  ) : (
    <SavedNoteSheet {...view} />
  );
}
