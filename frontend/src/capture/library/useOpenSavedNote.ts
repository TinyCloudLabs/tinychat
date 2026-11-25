// The recorder's Open (its receipt and the island), TC-761: the Library at
// once, then the note just saved, once one read through the per-space queue
// finds its row (a voice note's row is keyed by its recording id). If the user
// has moved on by then, or the row is not found, the Library stays.
import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { findMeetingId } from "@/lib/connectors/meetingExplorer";
import { scheduledSpace } from "@/lib/spaceQueue";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { notePath, PATHS } from "@/shell/routes";
import { onPhoneId } from "./onPhone";

/**
 * A recording's own page, by its recording id, with no read of the space: the Library opens the note on this device,
 * or its row once there is one (useLibrary resolves a stand-in id by recording id). Where the Mac's receipt leaves the
 * user when it closes by itself, whether or not the space can be reached.
 */
export function useShowRecordingNote(): (recordingId: string) => void {
  const navigate = useNavigate();
  return useCallback((recordingId: string) => navigate(notePath(onPhoneId(recordingId))), [navigate]);
}

export function useOpenSavedNote(tcw: TinyCloudWeb | null): (recordingId: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  const path = useRef(location.pathname);
  path.current = location.pathname;
  return useCallback(
    (recordingId: string) => {
      navigate(PATHS.library, { replace: path.current === PATHS.library });
      if (!tcw) return;
      void findMeetingId(scheduledSpace(tcw), VOICE_NOTE_SOURCE, recordingId).then((read) => {
        // Only while the Library the tap opened is still what shows.
        if (read.status === "ok" && path.current === PATHS.library) navigate(notePath(read.id), { replace: true });
      });
    },
    [navigate, tcw],
  );
}
