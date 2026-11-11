import { useEffect, useState } from "react";

import { CANONICAL_ORIGIN, deferOriginMove, LEGACY_HOSTNAME, moveWhenClear, type LocalRecordingWork } from "@/lib/originMove";

const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).host;

/** What a visitor held on tinycloud.chat reads. `saving: Infinity` means the check could not read this browser's recordings. */
export function originMoveNoticeText({ saving, localAudio }: LocalRecordingWork): string {
  const moved = `TinyCloud Home has moved to ${CANONICAL_HOST}.`;
  if (!Number.isFinite(saving)) {
    return `${moved} Recordings in this browser may still be saving here; you'll move automatically once they're saved.`;
  }
  if (saving > 0) {
    return saving === 1
      ? `${moved} 1 recording in this browser is still saving here; you'll move automatically once it's saved.`
      : `${moved} ${saving} recordings in this browser are still saving here; you'll move automatically once they're saved.`;
  }
  return localAudio === 1
    ? `${moved} This browser keeps the audio of 1 recording only here on ${LEGACY_HOSTNAME}, so you'll stay here.`
    : `${moved} This browser keeps the audio of ${localAudio} recordings only here on ${LEGACY_HOSTNAME}, so you'll stay here.`;
}

/** Quiet banner shown on the legacy origin while local-only recordings keep the visitor there. */
export function OriginMoveNotice({ work }: { work: LocalRecordingWork }) {
  return (
    <p role="status" className="pointer-events-none fixed inset-x-0 top-0 z-50 border-b border-border bg-muted/95 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-center text-xs text-muted-foreground">
      {originMoveNoticeText(work)}
    </p>
  );
}

/** The notice for a visitor held on tinycloud.chat, which moves them once nothing local-only is left. */
export function OriginMoveHold({ initialWork }: { initialWork: LocalRecordingWork }) {
  const [work, setWork] = useState(initialWork);
  useEffect(() => moveWhenClear({ onPending: setWork }), []);
  return <OriginMoveNotice work={work} />;
}

/** While `active`, a held page does not move (originMove.ts `deferOriginMove`): pass true while work lives only in memory. */
export function useOriginMoveDeferral(active: boolean): void {
  useEffect(() => (active ? deferOriginMove() : undefined), [active]);
}
