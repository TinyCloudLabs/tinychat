// A note (TC-761; moved from MeetingsPage.test.tsx and VoiceNotesListCard.test.tsx):
//   1. reads that did not land are told, with Try again, never shown as "no transcript";
//   2. the transcript with Copy; a missing transcript and missing audio said plainly;
//   3. transcription is offered only when available to this build AND account, and only after
//      the one-time private cloud consent; a hidden or still-checking engine offers nothing;
//   4. a voice note shows its progress, "No speech", or its failure (with Retry when it can help).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { aboutHref } from "@/lib/about";
import type { NoteTranscriptionState } from "@/lib/voiceNotes/voiceNoteTranscription";
import type { LibraryItem } from "./LibraryRow";
import { NoteDetailView, transcriptBlocks, type NoteDetailViewProps } from "./NoteDetailView";

const noop = () => {};
const VOICE: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note · Oct 6, 9:28 AM", startedAt: "2026-10-06T09:28:00.000Z", durationSecs: 42 };
const MEETING: LibraryItem = { id: "row-2", source: "tinycloud-transcriber", sourceId: "mtg-2", title: "Weekly sync", startedAt: "2026-10-05T14:00:00.000Z", durationSecs: 1880 };
const UPLOAD: LibraryItem = { id: "row-3", source: "exo-upload", sourceId: "up-3", title: "Interview", startedAt: "2026-10-01T11:00:00.000Z", durationSecs: 600 };
const loadAudio = async () => null;

function transcription(patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps {
  return { availability: "available", consented: true, maxSeconds: 600, jobs: new Map(), onTranscribe: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop, ...patch };
}

function render(patch: Partial<NoteDetailViewProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NoteDetailView
        item={VOICE}
        listStatus="ready"
        metadata={{ status: "ok", metadata: { capture: { platform: "ios" }, audio: { stored: true, base: "b" } } }}
        transcript={{ status: "ok", sentences: [] }}
        loadAudio={loadAudio}
        copyState="idle"
        onCopy={noop}
        onRetry={noop}
        pushed
        onBack={noop}
        {...patch}
      />
    </MemoryRouter>,
  );
}

describe("NoteDetailView", () => {
  test("an inserted voice-note row awaiting its audio explains its state", () => {
    expect(render({ item: VOICE, loadAudio: null, metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" } }))
      .toContain("Saving from your phone…");
  });
  test("a committed transcript with a missing body does not show its preview as full text", () => {
    const html = render({ item: VOICE, metadata: { status: "ok", metadata: {
      transcription_outcome: "transcribed", transcript_text: null,
    } }, transcript: { status: "absent" }, transcription: transcription() });
    expect(html).toContain("Couldn’t load this note’s full transcript.");
    expect(html).not.toContain("Not transcribed");
  });
  test("loading, failed (Try again) and absent, before the note is known", () => {
    expect(render({ item: null, listStatus: "loading" })).toContain('data-testid="note-loading"');
    const failed = render({ item: null, listStatus: "failed" });
    expect(failed).toContain("Couldn’t load this note.");
    expect(failed).toContain("Try again");
    expect(render({ item: null })).toContain("This note isn’t in your Library.");
  });

  test("title, meta, Play audio and How this got here", () => {
    const html = render({ item: MEETING, loadAudio: null, metadata: { status: "ok", metadata: { platform: "google_meet" } }, transcript: { status: "absent" } });
    expect(html).toContain(">Back</button>");
    expect(html).toContain("Weekly sync");
    expect(html).toContain("31 min · Notetaker");
    expect(html).toContain(">How this got here</h2>");
    expect(html).toContain("TinyCloud notetaker");
    expect(html).toContain("No transcript stored yet.");
    expect(html).not.toContain("Play audio");
    expect(render()).toContain("Play audio");
  });

  test("the transcript, by speaker, with Copy; a transcript read that did not land offers Try again", () => {
    const html = render({
      item: MEETING,
      transcript: {
        status: "ok",
        sentences: [
          { index: 0, speaker_name: "Ana", text: "We ship the beta.", start_time: 0, end_time: 1 },
          { index: 1, speaker_name: "Ana", text: "On Friday.", start_time: 1, end_time: 2 },
          { index: 2, speaker_name: "Ben", text: "Agreed.", start_time: 2, end_time: 3 },
        ],
      },
    });
    expect(html).toContain('data-testid="note-copy"');
    expect(html).toContain("We ship the beta. On Friday.");
    expect(html).toContain(">Ben</p>");
    expect(render({ copyState: "copied", transcript: { status: "ok", sentences: [{ index: 0, speaker_name: null, text: "Hi", start_time: 0, end_time: 1 }] } })).toContain("Copied");
    const failed = render({ transcript: { status: "failed" } });
    expect(failed).toContain("Couldn’t load the transcript.");
    expect(failed).toContain("Try again");
    expect(render({ transcript: undefined })).toContain("Loading the transcript…");
  });

  test("an upload whose audio was not stored says so", () => {
    const html = render({ item: UPLOAD, loadAudio: null, metadata: { status: "ok", metadata: { audio: { stored: false } } } });
    expect(html).toContain('data-testid="note-audio-missing"');
  });

  test("transcriptBlocks joins consecutive sentences of one speaker", () => {
    expect(
      transcriptBlocks([
        { index: 0, speaker_name: "You", text: "a", start_time: 0, end_time: 1 },
        { index: 1, speaker_name: "You", text: "b", start_time: 1, end_time: 2 },
      ]),
    ).toEqual([{ speaker: "You", text: "a b" }]);
  });
});

describe("a voice note's transcription", () => {
  const TRANSCRIBE_UI = ['data-testid="voice-note-transcribe"', 'data-testid="transcription-route"', "Private cloud transcribes"];
  const offersNothing = (html: string) => {
    for (const marker of TRANSCRIBE_UI) expect(html).not.toContain(marker);
  };

  test("a build or account without private cloud, or a pending check, offers nothing", () => {
    offersNothing(render());
    offersNothing(render({ transcription: transcription({ availability: "hidden" }) }));
    offersNothing(render({ transcription: transcription({ availability: "checking" }) }));
    offersNothing(render({ transcription: transcription({ availability: "failed", consented: false }) }));
    expect(render()).toContain("No transcript.");
  });

  test("available but not chosen: the route control with Off, and How it works; no Transcribe", () => {
    const html = render({ transcription: transcription({ consented: false }) });
    expect(html).toContain('data-route="off"');
    expect(html).toContain(`href="${aboutHref("transcription")}"`);
    expect(html).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("chosen: Transcribe; a note over the limit says so instead", () => {
    expect(render({ transcription: transcription() })).toContain('data-testid="voice-note-transcribe"');
    const long = render({ item: { ...VOICE, durationSecs: 900 }, transcription: transcription() });
    expect(long).toContain("Notes up to 10 minutes can be transcribed from the phone.");
    expect(long).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("no speech, progress, just saved, and a failure with Retry only when it can help", () => {
    const silent = render({ metadata: { status: "ok", metadata: { transcription_outcome: "no_speech" } }, transcription: transcription() });
    expect(silent).toContain("No speech was found in this note.");
    expect(silent).not.toContain('data-testid="voice-note-transcribe"');
    const job = (state: NoteTranscriptionState) => transcription({ jobs: new Map([["rec-1", state]]) });
    expect(render({ transcription: job({ kind: "active", status: { kind: "processing", completed: 1, total: 3 } }) })).toContain(
      "Transcribing in private cloud… 1/3",
    );
    expect(render({ transcription: job({ kind: "done", outcome: "transcribed" }) })).toContain("Transcript saved.");
    const failed = (retryable: boolean) =>
      job({ kind: "failed", code: "upload_interrupted", message: "The upload did not complete.", retryable, reference: "cid-7" });
    const retry = render({ transcription: failed(true) });
    expect(retry).toContain("Reference: cid-7");
    expect(retry).toContain('data-testid="voice-note-transcribe-retry"');
    expect(render({ transcription: failed(false) })).not.toContain('data-testid="voice-note-transcribe-retry"');
    // Private cloud unavailable right now: the failure is told, but Retry can't help.
    const unavailable = render({ transcription: transcription({ jobs: new Map([["rec-1", { kind: "failed", code: "upload_interrupted", message: "The upload did not complete.", retryable: true, reference: "cid-7" }]]), availability: "failed" }) });
    expect(unavailable).toContain("The upload did not complete.");
    expect(unavailable).not.toContain('data-testid="voice-note-transcribe-retry"');
  });

  test("what the reads can't tell is never offered Transcribe", () => {
    // The metadata read failed: transcribed, or no speech, is unknown.
    const unknown = render({ metadata: { status: "failed" }, transcription: transcription() });
    expect(unknown).toContain('data-testid="voice-note-transcript-unknown"');
    expect(unknown).not.toContain('data-testid="voice-note-transcribe"');
    // How this got here offers Try again, with no route; the player still plays.
    expect(unknown).toContain('data-testid="how-this-got-here-retry"');
    expect(unknown).not.toContain('aria-label="Where your audio goes"');
    expect(unknown).toContain("Play audio");
    // Marked transcribed, its transcript body missing: the text the row carries.
    const marked = render({
      metadata: { status: "ok", metadata: { transcription_outcome: "transcribed", transcript_text: "Book the venue." } },
      transcript: { status: "absent" },
      transcription: transcription(),
    });
    expect(marked).toContain("Book the venue.");
    expect(marked).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("a transcribed note shows its transcript whatever the engine's state", () => {
    const sentences = [{ index: 0, speaker_name: "You", text: "Book the venue.", start_time: 0, end_time: 1 }];
    for (const t of [undefined, transcription({ availability: "hidden" }), transcription()]) {
      const html = render({ transcript: { status: "ok", sentences }, transcription: t });
      expect(html).toContain("Book the venue.");
      expect(html).not.toContain('data-testid="voice-note-transcribe"');
    }
  });
});
