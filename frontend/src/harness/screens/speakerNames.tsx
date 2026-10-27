// Renaming a note's speakers (TC-2189) in the real shell over the fixture space: the Transcript before a rename,
// after it, and after Undo, for a Me/Them note, a diarized note and a meeting.
import { useEffect } from "react";

import { SPEAKER_ROWS } from "../fixtures/library";
import { CaptureShell } from "./capture";
import type { HarnessScreen } from "../screen";

type Step = { rename: string; to: string } | { undo: true };

/** Drives the open note's Transcript the way a person would: tap the label, type, save, then optionally Undo. */
function Act(props: { steps: Step[] }) {
  useEffect(() => {
    let cancelled = false;
    const wait = async <T,>(find: () => T | null | undefined): Promise<T | null> => {
      for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
        const found = find();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    };
    const visible = <E extends Element>(elements: Iterable<E>) => [...elements].find((element) => element.getClientRects().length > 0) ?? null;
    void (async () => {
      for (const step of props.steps) {
        if ("undo" in step) {
          const undo = await wait(() => document.querySelector<HTMLButtonElement>('[data-testid="speaker-rename-undo"]'));
          undo?.click();
          continue;
        }
        const label = await wait(() => visible(document.querySelectorAll<HTMLButtonElement>(`[data-testid="speaker-label"][aria-label="Rename speaker ${step.rename}"]`)));
        label?.click();
        const input = await wait(() => document.querySelector<HTMLInputElement>('[data-testid="speaker-rename-form"] input'));
        if (!input) return;
        input.value = step.to;
        input.form?.requestSubmit();
        await wait(() => document.querySelector('[data-testid="speaker-rename-status"]'));
      }
    })();
    return () => { cancelled = true; };
  }, [props.steps]);
  return null;
}

const NOTE = { group: "speakerNames", layout: "pane", displayTitle: true, platform: "ios" } as const;
const note = (id: string) => `/chat/capture/library/${id}`;
const READ = '[data-testid="note-transcript"]:not(:has([role="status"])) [data-testid="speaker-label"]';
const RENAMED = '[data-testid="speaker-rename-status"]';
const shell = (steps: Step[] = []) => () => <CaptureShell library rows={SPEAKER_ROWS}><Act steps={steps} /></CaptureShell>;

const ME_THEM: Step[] = [{ rename: "Me", to: "Sam" }, { rename: "Them", to: "Alice, Bob" }];
const DIARIZED: Step[] = [{ rename: "Speaker A", to: "Dana (interviewer)" }];
const MEETING: Step[] = [{ rename: "Ana", to: "Ana Ruiz" }];

export const speakerNameScreens: HarnessScreen[] = [
  { ...NOTE, id: "speakerNames-me-them-before", path: note("note-me-them"), readyWhen: READ, render: shell() },
  { ...NOTE, id: "speakerNames-me-them-after", path: note("note-me-them"), readyWhen: RENAMED, render: shell(ME_THEM) },
  { ...NOTE, id: "speakerNames-me-them-undo", path: note("note-me-them"), readyWhen: `${RENAMED}:not(:has([data-testid="speaker-rename-undo"]))`, render: shell([...ME_THEM, { undo: true }]) },
  { ...NOTE, id: "speakerNames-diarized-before", path: note("upload-interview"), readyWhen: READ, render: shell() },
  { ...NOTE, id: "speakerNames-diarized-after", path: note("upload-interview"), readyWhen: RENAMED, render: shell(DIARIZED) },
  { ...NOTE, id: "speakerNames-meeting-before", path: note("meeting-weekly"), readyWhen: READ, render: shell() },
  { ...NOTE, id: "speakerNames-meeting-after", path: note("meeting-weekly"), readyWhen: RENAMED, render: shell(MEETING) },
];
