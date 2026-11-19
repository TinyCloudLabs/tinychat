// What kind of capture a Library row is (TC-761): the filter's segments and
// each row's icon and label. Client-side, from `connector_meeting.source`.
import { FileAudioIcon, MicIcon, VideoIcon, type LucideIcon } from "lucide-react";

import { EXO_MERGED_SOURCE } from "@tinyboilerplate/core";
import { meetingSourceLabel } from "@/lib/connectors/meetingExplorer";
import { GMEET_MEETING_SOURCE } from "@/lib/connectors/gmeetNormalize";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { LOCAL_MEETING_SOURCE } from "@/lib/localTranscriber";
import { TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

export type LibraryKind = "note" | "meeting" | "upload";
/** `shared`: recordings other people shared with this account (TC-3195); none of the account's own rows. */
export type LibraryFilter = "all" | LibraryKind | "shared";

/** The kind filter's segments, in order. */
export const LIBRARY_FILTERS: readonly { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "note", label: "Notes" },
  { value: "meeting", label: "Meetings" },
  { value: "upload", label: "Uploads" },
];

/** After the kinds, in the signed-in Library only: what other people shared with this account. */
export const SHARED_FILTER: { value: LibraryFilter; label: string } = { value: "shared", label: "Shared with me" };

const KIND_BY_SOURCE: Readonly<Record<string, LibraryKind>> = {
  [VOICE_NOTE_SOURCE]: "note",
  [UPLOAD_MEETING_SOURCE]: "upload",
  fireflies: "meeting",
  [GMEET_MEETING_SOURCE]: "meeting",
  [TRANSCRIBER_MEETING_SOURCE]: "meeting",
  [LOCAL_MEETING_SOURCE]: "meeting",
  [EXO_MERGED_SOURCE]: "meeting",
};

/** A source nobody registered here is a meeting (every connector so far syncs meetings). */
export function libraryKind(source: string): LibraryKind {
  return KIND_BY_SOURCE[source] ?? "meeting";
}

/** An own row's place under the filter: never under "Shared with me", which lists shared recordings instead. */
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
  if (source === EXO_MERGED_SOURCE) return "Combined meeting";
  return meetingSourceLabel(source);
}

/** What the filter shows when it holds nothing. */
export function emptyFilterText(filter: LibraryFilter): string {
  if (filter === "note") return "No voice notes yet.";
  if (filter === "meeting") return "No meetings yet.";
  if (filter === "upload") return "No uploads yet.";
  if (filter === "shared") return "Nothing shared with you yet.";
  return "Nothing here yet.";
}
