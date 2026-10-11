import { useContext, useMemo, useRef, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlatformContext } from "@/lib/platform";
import { voiceNoteTitle } from "@/lib/voiceNotes/voiceNoteStore";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder } from "../../recorder/RecorderProvider";
import type { MeetingMetadataRead } from "@/lib/connectors/meetingExplorer";
import type { NoteAudio } from "../NoteDetailView";
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
  audio: NoteAudio | null;
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
  audio,
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
  // Read when the note loads, so the store (and the open editor) stay put when the row lands.
  const hasSpaceRow = useRef(item.onPhone !== true);
  hasSpaceRow.current = item.onPhone !== true;
  const space = useMemo(() => store ?? savedNoteStoreFor(tcw, () => hasSpaceRow.current), [store, tcw]);
  const screen = useSavedNoteScreen(item.sourceId, space);
  const view = {
    screen,
    layout,
    theme,
    id: item.id,
    recordingId: item.sourceId,
    title: item.title ?? voiceNoteTitle(Date.parse(item.startedAt ?? "") || Date.now()),
    meta: savedNoteMeta(
      item,
      metadata?.status === "ok" ? metadata.metadata : null,
      platform,
    ),
    audio,
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
