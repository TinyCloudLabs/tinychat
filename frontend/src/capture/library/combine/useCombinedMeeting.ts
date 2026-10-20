// TC-1152 S2c-1: what opening a combined meeting does, and its Delete.
//
//  - OPEN: `sweepCombinedMeeting` (S2b) reads the members. If one is gone (deleted by another device
//    or an older build) the combined meeting is deleted and the Library re-lists; `unverified` or a
//    failed sweep deletes nothing and the meeting stays on screen. Then `staleMembers` says whether a
//    member's text changed since combining ("a source changed · Re-combine").
//  - DELETE: `deleteCombined(tcw, 'exo-merged', row id)`. By row id and source only: it never reads
//    `metadata.merge`, so a row with garbage metadata is deletable. Originals are not touched.
import { useCallback, useEffect, useMemo, useState } from "react";
import { EXO_MERGED_SOURCE } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { deleteCombined, staleMembers, sweepCombinedMeeting } from "@/lib/connectors/combinedMeetingStore";
import { scheduledSpace } from "@/lib/spaceQueue";
import type { LibraryItem } from "../LibraryRow";

export interface CombinedMeetingController {
  /** A source's text changed since this was combined. */
  stale: boolean;
  remove: {
    open: boolean;
    busy: boolean;
    error: string | null;
    request: () => void;
    keep: () => void;
    confirm: () => void;
  };
}

export function useCombinedMeeting(options: {
  tcw: TinyCloudWeb;
  /** The open row; this does nothing unless it is a combined meeting. */
  item: LibraryItem | null;
  /** The sweep found the meeting gone, or Delete succeeded: re-list the Library. */
  onChanged: () => void;
  /** Delete succeeded: leave the page. */
  onDeleted: () => void;
}): CombinedMeetingController {
  const { tcw, item, onChanged, onDeleted } = options;
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const id = item !== null && item.source === EXO_MERGED_SOURCE ? item.id : null;
  const [stale, setStale] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStale(false);
    if (id === null) return;
    let live = true;
    void (async () => {
      const swept = await sweepCombinedMeeting(space, id);
      if (!live || !swept.ok) return;
      if (swept.data.status === "deleted") return onChanged();
      if (swept.data.status !== "kept") return;
      const drift = await staleMembers(space, id);
      if (live && drift.ok) setStale(drift.data.some((member) => member.state === "changed"));
    })();
    return () => { live = false; };
    // onChanged is the Library's refresh; a new identity must not repeat the sweep.
  }, [space, id]);

  const confirm = useCallback(() => {
    if (id === null || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await deleteCombined(space, EXO_MERGED_SOURCE, id);
        if (!res.ok) {
          setError("Couldn’t delete the combined meeting. Try again; your original captures weren’t changed.");
          return;
        }
        setAsking(false);
        onChanged();
        onDeleted();
      } catch {
        setError("Couldn’t delete the combined meeting. Try again; your original captures weren’t changed.");
      } finally {
        setBusy(false);
      }
    })();
  }, [space, id, busy, onChanged, onDeleted]);

  return {
    stale,
    remove: {
      open: asking && id !== null,
      busy,
      error,
      request: () => { setError(null); setAsking(true); },
      keep: () => { if (!busy) setAsking(false); },
      confirm,
    },
  };
}
