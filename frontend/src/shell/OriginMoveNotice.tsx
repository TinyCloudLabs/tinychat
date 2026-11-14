import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { onPhoneId } from "@/capture/library/onPhone";
import { CANONICAL_ORIGIN, deferOriginMove, holdsOriginMove, moveWhenClear, type LocalRecordingWork } from "@/lib/originMove";
import { LOCAL_AUDIO_LIBRARY_PATH, notePath, PATHS } from "./routes";

const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).host;

/** One piece of a notice line: text, or a recording count that links where those recordings are dealt with. */
export type NoticePart = string | { text: string; to: string };

const recordings = (n: number) => (n === 1 ? "1 recording" : `${n} recordings`);

/** The lines a visitor held on tinycloud.chat reads. `saving: Infinity` means the check could not read this browser's recordings. */
export function originMoveNoticeLines(work: LocalRecordingWork): NoticePart[][] {
  const moved = `TinyCloud One has moved to ${CANONICAL_HOST}.`;
  const { saving, localAudio, unclaimed, otherAccount, signedIn } = work;
  if (!Number.isFinite(saving)) {
    return [[`${moved} Recordings in this browser may still be saving here; you'll move automatically once they're saved.`]];
  }
  if (saving > 0) {
    return [[saving === 1
      ? `${moved} 1 recording in this browser is still saving here; you'll move automatically once it's saved.`
      : `${moved} ${saving} recordings in this browser are still saving here; you'll move automatically once they're saved.`]];
  }
  const lines: NoticePart[][] = [[moved]];
  if (localAudio.length > 0) {
    const one = localAudio.length === 1;
    lines.push([
      "The audio of ",
      { text: recordings(localAudio.length), to: one ? notePath(onPhoneId(localAudio[0]!)) : LOCAL_AUDIO_LIBRARY_PATH },
      one
        ? " is only in this browser, so this tab stays here until you upload it: open the recording and choose Upload audio to TinyCloud."
        : " is only in this browser, so this tab stays here until you upload them: open each recording and choose Upload audio to TinyCloud.",
    ]);
  }
  if (unclaimed > 0) {
    const one = unclaimed === 1;
    const save = signedIn
      ? one
        ? " On the Recording tab, under Recorded while signed out, choose Save to this account."
        : " On the Recording tab, under Recorded while signed out, choose Save to this account for each one."
      : one
        ? " Sign in, then on the Recording tab, under Recorded while signed out, choose Save to this account."
        : " Sign in, then on the Recording tab, under Recorded while signed out, choose Save to this account for each one.";
    lines.push([
      { text: recordings(unclaimed), to: PATHS.capture },
      one ? " in this browser isn't in any account yet." : " in this browser aren't in any account yet.",
      save,
    ]);
  }
  if (otherAccount > 0) {
    lines.push([
      { text: recordings(otherAccount), to: PATHS.capture },
      otherAccount === 1
        ? " in this browser belongs to another TinyCloud account. Sign in to that account here to save it."
        : " in this browser belong to another TinyCloud account. Sign in to that account here to save them.",
    ]);
  }
  if (unclaimed > 0 || otherAccount > 0) lines.push(["This tab stays here while these recordings are only in this browser."]);
  return lines;
}

/** The notice as plain text: its lines in order, one space apart. */
export function originMoveNoticeText(work: LocalRecordingWork): string {
  return originMoveNoticeLines(work).map((line) => line.map((part) => (typeof part === "string" ? part : part.text)).join("")).join(" ");
}

/** Quiet banner shown on the legacy origin while local-only recordings keep the visitor there; nothing for zero work. */
export function OriginMoveNotice({ work }: { work: LocalRecordingWork }) {
  if (!holdsOriginMove(work)) return null;
  return (
    <p role="status" className="pointer-events-none fixed inset-x-0 top-0 z-50 border-b border-border bg-muted/95 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-center text-xs text-muted-foreground">
      {originMoveNoticeLines(work).map((line, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="block">
            {line.map((part, j) => (typeof part === "string" ? part : (
              <Link key={j} to={part.to} className="pointer-events-auto font-medium text-foreground underline underline-offset-2">{part.text}</Link>
            )))}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * The notice for a visitor held on tinycloud.chat, which moves them once nothing local-only is left. Shows nothing
 * until `moveWhenClear` reports a count, which it does only once home.tinycloud.xyz serves this build.
 */
export function OriginMoveHold() {
  const [work, setWork] = useState<LocalRecordingWork | null>(null);
  useEffect(() => moveWhenClear({ onPending: setWork }), []);
  return work && <OriginMoveNotice work={work} />;
}

/** While `active`, a held page does not move (originMove.ts `deferOriginMove`): pass true while work lives only in memory. */
export function useOriginMoveDeferral(active: boolean): void {
  useEffect(() => (active ? deferOriginMove() : undefined), [active]);
}
