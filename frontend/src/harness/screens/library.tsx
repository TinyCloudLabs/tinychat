// The Library and a note (TC-761, PR6) in the real shell over the fixture
// space (harness/fixtures/library.ts): a phone pushes each screen; from
// medium up the list pane sits beside the note.
import { useEffect } from "react";

import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { LIBRARY_ROWS } from "../fixtures/library";
import { CaptureShell } from "./capture";
import type { HarnessScreen } from "../screen";

const noop = () => {};
/** A space with no uploads in it, for the empty Uploads filter. */
const NO_UPLOADS = LIBRARY_ROWS.filter((row) => row.source !== "exo-upload");

/** Taps a Library filter once the list has loaded. */
function Filter(props: { label: string }) {
  useEffect(() => {
    let timer = 0;
    const attempt = (left: number) => {
      const segment = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="library-list"][data-state="ready"] [role="radio"]')].find(
        (radio) => radio.textContent?.trim() === props.label && radio.getClientRects().length > 0,
      );
      if (segment) {
        segment.click();
        return;
      }
      if (left > 0) timer = window.setTimeout(() => attempt(left - 1), 100);
    };
    attempt(40);
    return () => window.clearTimeout(timer);
  }, [props.label]);
  return null;
}

const PRIVATE_CLOUD_ON: VoiceNoteTranscriptionProps = {
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
};
const TRANSCRIBES: Partial<RecorderValue> = { available: true, transcription: PRIVATE_CLOUD_ON };

// The Library sits under the Soft header, set in Fraunces, so the Literata font check does not apply.
const LIBRARY = { group: "library", layout: "pane", displayTitle: false, path: "/chat/capture/library", platform: "ios" } as const;
const LISTED = '[data-testid="library-list"][data-state="ready"]';
/** Only voice notes are listed: the Notes filter has applied. */
const NOTES_ONLY = `${LISTED}:has([data-testid="voice-note-item"]):not(:has([data-testid="library-item"]))`;

const NOTE = { group: "note", layout: "pane", displayTitle: true, platform: "ios" } as const;
const note = (id: string) => `/chat/capture/library/${id}`;
const READ = '[data-testid="note-transcript"]:not(:has([role="status"]))';

export const libraryScreens: HarnessScreen[] = [
  { ...LIBRARY, id: "library-all", readyWhen: LISTED, render: () => <CaptureShell library /> },
  {
    ...LIBRARY,
    id: "library-notes",
    readyWhen: NOTES_ONLY,
    render: () => (
      <CaptureShell library>
        <Filter label="Notes" />
      </CaptureShell>
    ),
  },
  {
    ...LIBRARY,
    id: "library-empty-filter",
    readyWhen: '[data-testid="library-empty"]',
    render: () => (
      <CaptureShell library rows={NO_UPLOADS}>
        <Filter label="Uploads" />
      </CaptureShell>
    ),
  },
  { ...LIBRARY, id: "library-loading", readyWhen: '[data-testid="library-list"][data-state="loading"]', render: () => <CaptureShell library hang /> },
  { ...NOTE, id: "note-voice-transcribed", path: note("note-transcribed"), readyWhen: READ, render: () => <CaptureShell library /> },
  {
    ...NOTE,
    id: "note-voice-untranscribed",
    path: note("note-untranscribed"),
    readyWhen: '[data-testid="voice-note-transcribe"]',
    render: () => <CaptureShell library recorder={TRANSCRIBES} />,
  },
  { ...NOTE, id: "note-meeting", path: note("meeting-weekly"), readyWhen: READ, render: () => <CaptureShell library /> },
  { ...NOTE, id: "note-upload-assemblyai", path: note("upload-interview"), readyWhen: READ, render: () => <CaptureShell library /> },
  { ...NOTE, id: "note-missing-audio", path: note("upload-board"), readyWhen: '[data-testid="note-audio-missing"]', render: () => <CaptureShell library /> },
];
