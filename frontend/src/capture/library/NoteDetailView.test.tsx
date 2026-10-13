// A note (TC-761; moved from MeetingsPage.test.tsx and VoiceNotesListCard.test.tsx):
//   1. reads that did not land are told, with Try again, never shown as "no transcript";
//   2. the transcript with Copy; a missing transcript and missing audio said plainly;
//   3. transcription is offered only when available to this build AND account (consent is asked when
//      Private is chosen); a failed or still-checking engine offers nothing;
//   4. a voice note shows its progress, "No speech", or its failure (with Retry when it can help).
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import {
  __desktopWhisperQueueReadsForTests,
  registerDesktopWhisperQueue,
  type DesktopWhisperJob,
  type DesktopWhisperQueue,
} from "@/lib/voiceNotes/desktop/desktopWhisper";
import { HELD_NOTE_MESSAGE, type NoteTranscriptionState } from "@/lib/voiceNotes/voiceNoteTranscription";
import type { LibraryItem } from "./LibraryRow";
import { NotePipelineContext } from "@/capture/pipeline/NotePipelineContext";
import { allDone, pipelineOf, signedOut, uploading, waitingForModel } from "@/capture/pipeline/pipelineFixtures";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import { SAVED_NOTE_COPY } from "./savedNote/savedNoteCopy";
import { NoteDetailView, transcriptBlocks, transcriptStepLine, type NoteDetailViewProps } from "./NoteDetailView";

const noop = () => {};
const VOICE: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note · Oct 6, 9:28 AM", startedAt: "2026-10-06T09:28:00.000Z", durationSecs: 42 };
const MEETING: LibraryItem = { id: "row-2", source: "tinycloud-transcriber", sourceId: "mtg-2", title: "Weekly sync", startedAt: "2026-10-05T14:00:00.000Z", durationSecs: 1880 };
const UPLOAD: LibraryItem = { id: "row-3", source: "exo-upload", sourceId: "up-3", title: "Interview", startedAt: "2026-10-01T11:00:00.000Z", durationSecs: 600 };
const audio = { load: async () => null };

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
        audio={audio}
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
  test("a note only on this phone opens from its own audio, titled by its time, with nothing to transcribe or explain", () => {
    const onPhone: LibraryItem = { ...VOICE, id: "on-phone:rec-1", title: null, onPhone: true };
    const html = render({ item: onPhone, metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" }, transcription: undefined });
    expect(html).toContain("Voice note ·");
    expect(html).toContain('data-testid="note-transcript-on-phone"');
    expect(html).toContain("No transcript yet. It shows here once this note is saved to your space.");
    expect(html).not.toContain("Saving from your phone…");
    expect(html).not.toContain("Transcribe");
    expect(html).not.toContain("How this got here");
  });
  test("an inserted voice-note row awaiting its audio explains its state", () => {
    expect(render({ item: VOICE, audio: null, metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" } }))
      .toContain("Saving from your phone…");
  });
  test("an over-limit note explains the advertised maximum before offering Transcribe", () => {
    const html = render({ item: { ...VOICE, durationSecs: 10_800 }, transcription: transcription({ maxSeconds: 7_200 }) });
    expect(html).toContain('data-testid="voice-note-transcription-over-limit"');
    expect(html).toContain("Private Transcription accepts notes up to 2 h. This note is 3 h.");
    expect(html).not.toContain('data-testid="voice-note-transcribe"');
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
    const html = render({ item: MEETING, audio: null, metadata: { status: "ok", metadata: { platform: "google_meet" } }, transcript: { status: "absent" } });
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
    expect(html).toContain("We ship the beta.");
    expect(html).toContain("On Friday.");
    expect(html).toContain('aria-label="Play from 0:01"');
    expect(html).toContain(">Ben</p>");
    expect(render({ copyState: "copied", transcript: { status: "ok", sentences: [{ index: 0, speaker_name: null, text: "Hi", start_time: 0, end_time: 1 }] } })).toContain("Copied");
    const failed = render({ transcript: { status: "failed" } });
    expect(failed).toContain("Couldn’t load the transcript.");
    expect(failed).toContain("Try again");
    expect(render({ transcript: undefined })).toContain("Loading the transcript…");
  });

  test("timed copy is absent when the caller has no handler", () => {
    const html = render({ transcript: { status: "ok", sentences: [
      { index: 0, speaker_name: null, text: "Ready.", start_time: 1, end_time: 2 },
    ] } });
    expect(html).not.toContain("Copy with timestamps");
    expect(html).toContain("Export as Markdown");
  });

  test("an upload whose audio was not stored says so", () => {
    const html = render({ item: UPLOAD, audio: null, metadata: { status: "ok", metadata: { audio: { stored: false } } } });
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
  const TRANSCRIBE_UI = ['data-testid="transcribe-button"', 'data-testid="transcription-route"', "Private cloud transcribes"];
  const offersNothing = (html: string) => {
    for (const marker of TRANSCRIBE_UI) expect(html).not.toContain(marker);
  };

  test("a build or account without private cloud, or a pending check, offers nothing", () => {
    offersNothing(render());
    offersNothing(render({ transcription: transcription({ availability: "failed" }) }));
    offersNothing(render({ transcription: transcription({ availability: "checking" }) }));
    offersNothing(render({ transcription: transcription({ availability: "failed", consented: false }) }));
    expect(render()).toContain("No transcript.");
  });

  test("available but not yet consented: Transcribe with Private, which asks for consent when pressed", () => {
    const html = render({ transcription: transcription({ consented: false }) });
    expect(html).toContain('data-testid="transcribe-button"');
    expect(html).toContain('data-testid="transcribe-provider-static"');
    expect(html).not.toContain('data-testid="transcribe-consent"');
  });

  test("chosen: Transcribe, for a long note too while it is within the advertised limit", () => {
    expect(render({ transcription: transcription() })).toContain('data-testid="transcribe-button"');
    const long = render({ item: { ...VOICE, durationSecs: 900 }, transcription: transcription({ maxSeconds: 7_200 }) });
    expect(long).toContain('data-testid="transcribe-button"');
    expect(long).not.toContain("minutes can be transcribed");
  });

  test("a legacy empty body without an outcome remains a transcribe candidate", () => {
    const html = render({
      metadata: { status: "ok", metadata: { audio: { stored: true } } },
      transcript: { status: "ok", sentences: [] },
      transcription: transcription(),
    });
    expect(html).toContain("Not transcribed");
    expect(html).toContain('data-testid="transcribe-button"');
  });

  test("no speech, progress, just saved, and a failure with Retry only when it can help", () => {
    const silent = render({ metadata: { status: "ok", metadata: { transcription_outcome: "no_speech" } }, transcription: transcription() });
    expect(silent).toContain("No speech was found in this note.");
    expect(silent).not.toContain('data-testid="transcribe-button"');
    const job = (state: NoteTranscriptionState) => transcription({ jobs: new Map([["rec-1", state]]) });
    expect(render({ transcription: job({ kind: "active", status: { kind: "processing", completed: 1, total: 3 } }) })).toContain(
      "Transcribing in private cloud… 1/3",
    );
    expect(render({ transcription: job({ kind: "done", outcome: "transcribed" }) })).toContain("Transcript saved.");
    const failed = (retryable: boolean) =>
      job({ kind: "failed", code: "upload_interrupted", message: "The upload did not complete.", retryable, reference: "cid-7" });
    const retry = render({ transcription: failed(true) });
    expect(retry).toContain("Reference: cid-7");
    expect(retry).toContain('data-testid="transcribe-button"');
    expect(retry).toContain("Try again");
    expect(render({ transcription: failed(false) })).not.toContain('data-testid="transcribe-button"');
    // Private cloud unavailable right now: the failure is told, but Retry can't help.
    const unavailable = render({ transcription: transcription({ jobs: new Map([["rec-1", { kind: "failed", code: "upload_interrupted", message: "The upload did not complete.", retryable: true, reference: "cid-7" }]]), availability: "failed" }) });
    expect(unavailable).toContain("The upload did not complete.");
    expect(unavailable).not.toContain('data-testid="transcribe-button"');
    expect(unavailable).toContain('data-testid="transcribe-private-recheck"');
  });

  test("a note held back says why and offers Transcribe with Private only while private cloud is on offer", () => {
    const held = (extra: Partial<Parameters<typeof transcription>[0]> = {}) =>
      transcription({ jobs: new Map([["rec-1", { kind: "held", message: HELD_NOTE_MESSAGE }]]), ...extra });
    const html = render({ transcription: held() });
    expect(html).toContain("started from a shortcut, so it was not sent for transcription");
    expect(html).toContain('data-testid="voice-note-transcription-held"');
    expect(html).toContain('data-testid="transcribe-button"');
    const unavailable = render({ transcription: held({ availability: "checking" }) });
    expect(unavailable).toContain("so it was not sent for transcription");
    expect(unavailable).not.toContain('data-testid="transcribe-button"');
  });

  test("what the reads can't tell is never offered Transcribe", () => {
    // The metadata read failed: transcribed, or no speech, is unknown.
    const unknown = render({ metadata: { status: "failed" }, transcription: transcription() });
    expect(unknown).toContain('data-testid="voice-note-transcript-unknown"');
    expect(unknown).not.toContain('data-testid="transcribe-button"');
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
    expect(marked).not.toContain('data-testid="transcribe-button"');
  });

  test("a transcribed note shows its transcript whatever the engine's state", () => {
    const sentences = [{ index: 0, speaker_name: "You", text: "Book the venue.", start_time: 0, end_time: 1 }];
    for (const t of [undefined, transcription({ availability: "failed" }), transcription()]) {
      const html = render({ transcript: { status: "ok", sentences }, transcription: t });
      expect(html).toContain("Book the venue.");
      expect(html).not.toContain('data-testid="transcribe-button"');
    }
  });
});

describe("a voice note with an after-stop Whisper job on the Mac", () => {
  afterEach(() => registerDesktopWhisperQueue(null));
  const withJob = (job: Partial<DesktopWhisperJob> | null, patch: Partial<NoteDetailViewProps> = {}) => {
    const jobs = new Map(job ? [["rec-1", { id: "rec-1", state: "queued", error: null, progress: null, ...job } as DesktopWhisperJob]] : []);
    registerDesktopWhisperQueue({ snapshot: () => jobs, subscribe: () => noop } as unknown as DesktopWhisperQueue);
    return render({ desktopWhisper: true, ...patch });
  };

  const localTranscript = { version: 1 as const, noteId: "rec-1", transcriber: "on-device" as const,
    rev: 1, engine: "whispercpp" as const, model: "QuantizedTinyEn", language: "en",
    outcome: "transcribed" as const, diarized: false,
    segments: [{ start: 0, end: 1000, text: "Saved on this Mac", speaker: null }], createdAt: "2026-10-13T10:00:00Z" };

  test("shows the durable device text before upload, then the space body by source id", () => {
    const local = withJob({ state: "done" }, { transcript: { status: "absent" }, localTranscript });
    expect(local).toContain("Saved on this Mac");
    expect(local).toContain('data-testid="note-copy"');
    expect(local).not.toContain("Transcript saved.");
    const remote = withJob({ state: "done" }, { localTranscript,
      transcript: { status: "ok", sentences: [{ index: 0, speaker_name: null, text: "Saved in the space", start_time: 0, end_time: 1 }] } });
    expect(remote).toContain("Saved in the space");
    expect(remote).not.toContain("Saved on this Mac");
    expect(withJob({ state: "done" }, { localTranscript: { ...localTranscript, noteId: "another-note" } })).not.toContain("Saved on this Mac");
  });

  test("an empty durable local result says no speech", () => {
    const html = withJob({ state: "done" }, { localTranscript: { ...localTranscript, outcome: "no_speech", segments: [] } });
    expect(html).toContain("No speech was found in this note.");
    expect(html).not.toContain("Transcript saved.");
  });

  test("the space's no-speech outcome wins without a local read error", () => {
    const html = withJob({ state: "done" }, { metadata: { status: "ok", metadata: { transcription_outcome: "no_speech" } }, localTranscript: null });
    expect(html).toContain("No speech was found in this note.");
    expect(html).not.toContain("Couldn’t read the transcript saved on this Mac.");
  });

  test("an older device copy names a failed space read and offers retry", () => {
    const html = withJob({ state: "done" }, { localTranscript, transcript: { status: "failed", message: "offline" } });
    expect(html).toContain("Saved on this Mac");
    expect(html).toContain("On this device · Couldn’t check your space.");
    expect(html).toContain("Try again");
    const silent = withJob({ state: "done" }, { localTranscript: { ...localTranscript, outcome: "no_speech", segments: [] },
      transcript: { status: "failed", message: "offline" } });
    expect(silent).toContain("No speech was found in this note.");
    expect(silent).toContain("On this device · Couldn’t check your space.");
  });

  test("a timed-out local read has a typed message and retry", () => {
    const html = withJob({ state: "done" }, { localTranscript: null, localTranscriptRead: "timeout", onLocalTranscriptRetry: noop });
    expect(html).toContain("Checking the transcript on this Mac took too long.");
    expect(html).toContain("Try again");
  });

  test("signed out (no private-cloud props): queued, progress and failure with Retry show on the page", () => {
    const before = __desktopWhisperQueueReadsForTests();
    expect(withJob({ state: "queued" })).toContain("Waiting to transcribe on this Mac");
    // The counter sees the enabled path, so its silence outside the desktop app means something.
    expect(__desktopWhisperQueueReadsForTests()).toBeGreaterThan(before);
    expect(withJob({ state: "transcribing", progress: 33 })).toContain("Transcribing on this Mac · 33%");
    const failed = withJob({ state: "failed", error: "raw detail" });
    expect(failed).toContain('data-testid="whisper-job-retry"');
    expect(failed).not.toContain("raw detail");
    expect(failed).not.toContain("No transcript.");
  });

  test("outside the desktop app it renders as before and never reads the queue", () => {
    const calls: string[] = [];
    const job: DesktopWhisperJob = { id: "rec-1", state: "failed", error: "raw detail", progress: null };
    registerDesktopWhisperQueue({
      snapshot: () => { calls.push("snapshot"); return new Map([["rec-1", job]]); },
      subscribe: () => { calls.push("subscribe"); return noop; },
    } as unknown as DesktopWhisperQueue);
    // The production default (no override): the shell isn't Tauri in tests.
    const before = __desktopWhisperQueueReadsForTests();
    const classic = render();
    expect(__desktopWhisperQueueReadsForTests()).toBe(before);
    expect(render({ desktopWhisper: false })).toBe(classic);
    expect(__desktopWhisperQueueReadsForTests()).toBe(before);
    expect(classic).toContain("No transcript.");
    expect(classic).not.toContain("whisper-job");
    expect(calls).toEqual([]);
  });

  test("without a job the page is unchanged", () => {
    expect(withJob(null)).toBe(render());
    expect(withJob(null)).toContain("No transcript.");
  });
});

describe("the transcript placeholder while the note's pipeline is not done", () => {
  const onPhone: LibraryItem = { ...VOICE, id: "on-phone:rec-1", title: null, onPhone: true };
  const withContext = (pipeline: NotePipeline) =>
    renderToStaticMarkup(
      <NotePipelineContext.Provider value={{ pipeline, onAction: noop, actionError: null }}>
        <MemoryRouter>
          <NoteDetailView item={onPhone} listStatus="ready" metadata={{ status: "ok", metadata: {} }} transcript={{ status: "absent" }} audio={audio} copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} />
        </MemoryRouter>
      </NotePipelineContext.Provider>,
    );

  test("a note still uploading says where the transcript will show, not 'No transcript yet'", () => {
    const html = withContext(uploading(30));
    expect(html).toContain('data-testid="note-transcript-pipeline"');
    expect(html).toContain("After audio uploads");
    expect(html).not.toContain("No transcript yet");
    expect(html).not.toContain('data-testid="note-transcript-on-phone"');
  });

  test("a signed-out note does not repeat the sign-in blocker under Transcript", () => {
    const pipeline = signedOut();
    const html = withContext(pipeline);
    expect(html).toContain("After audio uploads");
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("No transcript yet");
  });

  test("a note waiting for the model: the transcript step is the current one, so the line says where it will appear", () => {
    const pipeline = waitingForModel();
    expect(pipeline.current).toBe("transcript");
    expect(withContext(pipeline)).toContain(SAVED_NOTE_COPY.transcriptHere);
  });

  describe("a saved note whose transcript the phone is adding to the note", () => {
    const saved: LibraryItem = { ...VOICE };
    const adding = (route: "on-device" | "private-cloud") => pipelineOf({
      route,
      space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
      transcript: route === "on-device"
        ? { inSpace: null, cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: { state: "ready", bytes: 640, totalBytes: 640, error: null }, download: "idle", sync: { state: "syncing" } } }
        : { inSpace: null, onDevice: null, cloud: null },
    });
    const offer = (route: "on-device" | "private-cloud", jobs: VoiceNoteTranscriptionProps["jobs"] = new Map()) =>
      renderToStaticMarkup(
        <NotePipelineContext.Provider value={{ pipeline: adding(route), route, onAction: noop, actionError: null }}>
          <MemoryRouter>
            <NoteDetailView item={saved} listStatus="ready" metadata={{ status: "ok", metadata: { capture: { platform: "ios" } } }} transcript={{ status: "absent" }} audio={audio} copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} transcription={transcription({ jobs })} />
          </MemoryRouter>
        </NotePipelineContext.Provider>,
      );

    test("the stepper's 'Adding to this note…' is not contradicted by 'Not transcribed' and Transcribe", () => {
      const html = offer("on-device");
      expect(html).not.toContain("Not transcribed");
      expect(html).not.toContain("transcribe-action");
      expect(html).toContain(SAVED_NOTE_COPY.transcriptHere);
    });

    test("a note about to be transcribed in private cloud by itself shows only the stepper", () => {
      const html = offer("private-cloud");
      expect(html).not.toContain("Not transcribed");
      expect(html).not.toContain("transcribe-button");
      expect(html).toContain(SAVED_NOTE_COPY.transcriptHere);
    });

    test("a held note offers Transcribe and does not also say the transcript will appear by itself", () => {
      const html = offer("private-cloud", new Map([["rec-1", { kind: "held", message: "This note did not start here." }]]));
      expect(html).toContain('data-testid="transcribe-button"');
      expect(html).not.toContain(SAVED_NOTE_COPY.transcriptHere);
    });
  });

  test("done, or no pipeline at all: the plain empty state stands", () => {
    expect(transcriptStepLine(allDone())).toBeNull();
    expect(withContext(allDone())).not.toContain('data-testid="note-transcript-pipeline"');
    expect(render({ item: onPhone, metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" }, transcription: undefined })).toContain("No transcript yet.");
  });
});
