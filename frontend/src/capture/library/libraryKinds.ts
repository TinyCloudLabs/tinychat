// What kind of capture a Library row is (TC-761): the filter's segments and
// each row's icon and label. Client-side, from `connector_meeting.source`.
import { FileAudioIcon, MicIcon, VideoIcon, type LucideIcon } from "lucide-react";

import { meetingSourceLabel } from "@/lib/connectors/meetingExplorer";
import { GMEET_MEETING_SOURCE } from "@/lib/connectors/gmeetNormalize";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { LOCAL_MEETING_SOURCE } from "@/lib/localTranscriber";
import { TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

export type LibraryKind = "note" | "meeting" | "upload";
export type LibraryFilter = "all" | LibraryKind;

/** The filter's segments, in order. */
export const LIBRARY_FILTERS: readonly { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "note", label: "Notes" },
  { value: "meeting", label: "Meetings" },
  { value: "upload", label: "Uploads" },
];

const KIND_BY_SOURCE: Readonly<Record<string, LibraryKind>> = {
  [VOICE_NOTE_SOURCE]: "note",
  [UPLOAD_MEETING_SOURCE]: "upload",
  fireflies: "meeting",
  [GMEET_MEETING_SOURCE]: "meeting",
  [TRANSCRIBER_MEETING_SOURCE]: "meeting",
  [LOCAL_MEETING_SOURCE]: "meeting",
};

/** A source nobody registered here is a meeting (every connector so far syncs meetings). */
export function libraryKind(source: string): LibraryKind {
  return KIND_BY_SOURCE[source] ?? "meeting";
}

export function matchesFilter(source: string, filter: LibraryFilter): boolean {
  return filter === "all" || libraryKind(source) === filter;
}

export const KIND_ICON: Readonly<Record<LibraryKind, LucideIcon>> = {
  note: MicIcon,
  meeting: VideoIcon,
  upload: FileAudioIcon,
};

/** The short source name on a row's meta line ("Fireflies", "Notetaker", "Upload"). */
export function librarySourceLabel(source: string): string {
  if (source === TRANSCRIBER_MEETING_SOURCE) return "Notetaker";
  if (source === UPLOAD_MEETING_SOURCE) return "Upload";
  return meetingSourceLabel(source);
}

/** What the filter shows when it holds nothing. */
export function emptyFilterText(filter: LibraryFilter): string {
  if (filter === "note") return "No voice notes yet.";
  if (filter === "meeting") return "No meetings yet.";
  if (filter === "upload") return "No uploads yet.";
  return "Nothing here yet.";
}
