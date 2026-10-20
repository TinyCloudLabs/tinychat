// A note (TC-761; moved from MeetingsPage.test.tsx and VoiceNotesListCard.test.tsx):
//   1. reads that did not land are told, with Try again, never shown as "no transcript";
//   2. the transcript with Copy; a missing transcript and missing audio said plainly;
//   3. transcription is offered only when available to this build AND account (consent is asked when
//      Private is chosen); a failed or still-checking engine offers nothing;
//   4. a voice note shows its progress, "No speech", or its failure (with Retry when it can help).
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { localTranscriptTurns, MIC_CHANNEL, type LocalWord } from "@/lib/localTranscriptTurns";

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
import { PipelineTrackSummary, pipelineTrackLabel } from "@/capture/pipeline/PipelineTrackSummary";
import { allDone, pipelineOf, signedOut, uploading, waitingForModel } from "@/capture/pipeline/pipelineFixtures";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import { SAVED_NOTE_COPY } from "./savedNote/savedNoteCopy";
import { NoteDetailView, transcriptBlocks, transcriptStepLine, type NoteDetailViewProps } from "./NoteDetailView";

const noop = () => {};
const VOICE: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note · Oct 6, 9:28 AM", startedAt: "2026-10-06T09:28:00.000Z", durationSecs: 42 };
const MEETING: LibraryItem = { id: "row-2", source: "tinycloud-transcriber", sourceId: "mtg-2", title: "Weekly sync", startedAt: "2026-10-05T14:00:00.000Z", durationSecs: 1880 };
const UPLOAD: LibraryItem = { id: "row-3", source: "exo-upload", sourceId: "up-3", title: "Interview", startedAt: "2026-10-01T11:00:00.000Z", durationSecs: 600 };
const PRIVATE_CAP = 7_777;
const audio = { load: async () => null };

function transcription(patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps {
  return { availability: "available", consented: true, maxSeconds: 600, maxBytes: 186_496_800, jobs: new Map(), onTranscribe: noop, onTranscribeAgain: () => null, onConsent: noop, onTurnOff: noop, onRecheck: noop, ...patch };
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
  test("pasted transcript shows exact line breaks and no audio player", () => {
    const pasted = { ...VOICE, title: "Interview", durationSecs: null, metadata: { capture: "pasted" } };
    const html = render({ item: pasted, audio: null, metadata: { status: "ok", metadata: {
      capture: "pasted", transcription_outcome: "transcribed", transcript_text: "[01:02] Alice: Hello\n\nBob: Hi",
    } }, transcript: { status: "ok", sentences: [
      { index: 0, speaker_name: "Alice", text: "Hello", start_time: 62, end_time: 62 },
      { index: 1, speaker_name: "Bob", text: "Hi", start_time: 0, end_time: 0 },
    ] } });
    expect(html).toContain("[01:02] Alice: Hello\n\nBob: Hi");
    expect(html).toContain("Pasted transcript saved to your TinyCloud space.");
    expect(html).not.toContain("Play audio");
    expect(html).not.toContain("Saving from your phone");
  });
  test("a combined meeting (exo-merged) opens like any meeting: title, label and its transcript", () => {
    const merged: LibraryItem = { id: "row-m", source: "exo-merged", sourceId: "merged-1", title: "Planning", startedAt: "2026-10-05T14:00:00.000Z", durationSecs: 3600 };
    const html = render({
      item: merged,
      audio: null,
      metadata: { status: "ok", metadata: {} },
      transcript: { status: "ok", sentences: [{ index: 0, speaker_name: "Ada", text: "Hello from the combined meeting.", start_time: 0, end_time: 3 }] },
    });
    expect(html).toContain("Planning");
    expect(html).toContain("Combined meeting");
    expect(html).toContain("Hello from the combined meeting.");
  });
  test("another device names the holding device and offers no broken player or Transcribe button", () => {
    const html = render({ audio: null, transcript: { status: "absent" }, transcription: transcription(),
      metadata: { status: "ok", metadata: { capture: { platform: "ios" }, audio: { stored: false, reason: "local_only", device: { platform: "ios" } } } } });
    expect(html).toContain("Audio is on your iPhone");
    expect(html).toContain("Transcribe on your iPhone");
    expect(html).not.toContain('data-testid="transcribe-button"');
    expect(html).not.toContain("meeting-audio-player");
  });
  test("a note only on this phone opens from its own audio, titled by its time, with nothing to transcribe or explain", () => {
    const onPhone: LibraryItem = { ...VOICE, id: "on-phone:rec-1", title: null, onPhone: true };
    const html = render({ item: onPhone, metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" }, transcription: undefined });
    expect(html).toContain("Voice note ·");
    expect(html).toContain('data-testid="note-transcript-on-phone"');
    expect(html).toContain("No transcript yet. It shows here once this note is saved to your space.");
    expect(html).not.toContain("Saving from this browser…");
    expect(html).not.toContain("Transcribe");
    expect(html).not.toContain("How this got here");
  });
  test("an inserted voice-note row awaiting its audio explains its state", () => {
    expect(render({ item: VOICE, audio: null, metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" } }))
      .toContain("Saving from this browser…");
  });
  test("an over-limit note explains the advertised maximum before offering Transcribe", () => {
    const html = render({ item: { ...VOICE, durationSecs: PRIVATE_CAP + 1 }, transcription: transcription({ maxSeconds: PRIVATE_CAP }) });
    expect(html).toContain('data-testid="voice-note-transcription-over-limit"');
    expect(html).toContain("Private Transcription accepts notes up to 2 h 9 min 36 s. This note is 2 h 9 min 38 s.");
    expect(html).not.toContain('data-testid="voice-note-transcribe"');
  });
  test("a note whose PTX limit is unknown says Private's limits aren't available, with no duration and no Transcribe", () => {
    const html = render({ item: { ...VOICE, durationSecs: 321 }, transcription: transcription({ maxSeconds: null }) });
    expect(html).toContain('data-testid="voice-note-transcription-limits-unknown"');
    expect(html).not.toContain('data-testid="voice-note-transcription-over-limit"');
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
  test("60-second transcript spans are timed only for PTX provenance", () => {
    const body = [
      { index: 0, speaker_name: "You", text: "Synthetic first.", start_time: 0, end_time: 45 },
      { index: 1, speaker_name: "You", text: "Synthetic second.", start_time: 45, end_time: 105 },
    ];
    const ptx = render({
      metadata: { status: "ok", metadata: { transcription_engine: "private-cloud" } },
      transcript: { status: "ok", sentences: body },
      onCopyWithTimestamps: noop,
    });
    expect(ptx).toContain('aria-label="Play from 0:45"');
    expect(ptx).toContain("Copy with timestamps");

    for (const metadata of [
      { status: "ok" as const, metadata: { transcription_engine: "whispercpp", transcript_provider: "whispercpp" } },
      { status: "ok" as const, metadata: { transcription_engine: "future-engine" } },
      { status: "absent" as const },
    ]) {
      const plain = render({ metadata, transcript: { status: "ok", sentences: body } });
      expect(plain).not.toContain("Play from 0:45");
      expect(plain).not.toContain("Copy with timestamps");
      expect(plain).toContain("Synthetic second.");
    }

    const providerOnly = render({
      metadata: { status: "ok", metadata: { transcript_provider: "tinycloud-private-transcription" } },
      transcript: { status: "ok", sentences: body },
    });
    expect(providerOnly).toContain('aria-label="Play from 0:45"');
    const committedPtx = render({
      metadata: { status: "ok", metadata: {} },
      transcriptProvenance: { engine: "private-cloud", provider: null },
      transcript: { status: "ok", sentences: body },
    });
    expect(committedPtx).toContain('aria-label="Play from 0:45"');
    const unknownCommit = render({
      metadata: { status: "ok", metadata: { transcription_engine: "private-cloud" } },
      transcriptProvenance: { engine: null, provider: null },
      transcript: { status: "ok", sentences: body },
    });
    expect(unknownCommit).not.toContain("Play from 0:45");
    expect(unknownCommit).not.toContain("Copy with timestamps");
  });

  test("real Local turn builder keeps its interpolated 60-second split untimed", () => {
    const words = Array.from({ length: 100 }, (_, index) => {
      const segment = Math.floor(index / 25);
      const word = index % 25;
      const start = segment * 25;
      const wordStart = start + word;
      return {
        text: `synthetic${index}`,
        start: wordStart,
        end: word === 24 ? Math.max(start + 24.9, wordStart + 0.05) : wordStart + 1,
        channel: MIC_CHANNEL,
      };
    }) satisfies LocalWord[];
    const turns = localTranscriptTurns(words);

    expect(turns.map(({ start_time, end_time }) => [start_time, end_time])).toEqual([[0, 60], [60, 99.9]]);
    const html = render({ metadata: { status: "absent" }, transcript: { status: "ok", sentences: turns } });
    expect(html).not.toContain('aria-label="Play from 1:00"');
    expect(html).not.toContain("Copy with timestamps");
    expect(html).toContain("synthetic60");
  });


  test("timed copy is absent when the caller has no handler", () => {
    const html = render({ transcript: { status: "ok", sentences: [
      { index: 0, speaker_name: null, text: "Ready.", start_time: 1, end_time: 2 },
    ] } });
    expect(html).not.toContain("Copy with timestamps");
    expect(html).toContain("Export as Markdown");
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

  test("a pending Private note without a live job always has an action or recovery explanation", () => {
    const pending = { status: "ok" as const, metadata: { capture: { options: { transcriber: "private-cloud" } }, transcription_outcome: "pending" } };
    const available = render({ metadata: pending, transcription: transcription() });
    expect(available).toContain('data-testid="transcribe-button"');

    const unavailable = render({ metadata: pending, transcription: transcription({ availability: "failed" }) });
    expect(unavailable).toContain('data-testid="voice-note-private-unavailable"');
    expect(unavailable).toContain("Private cloud isn’t reachable");
  });

  test("available but not yet consented: Transcribe with Private, which asks for consent when pressed", () => {
    const html = render({ transcription: transcription({ consented: false }) });
    expect(html).toContain('data-testid="transcribe-button"');
    expect(html).toContain('data-testid="transcribe-provider-static"');
    expect(html).not.toContain('data-testid="transcribe-consent"');
  });

  test("chosen: Transcribe, for a long note too while it is within the advertised limit", () => {
    expect(render({ transcription: transcription() })).toContain('data-testid="transcribe-button"');
    const long = render({ item: { ...VOICE, durationSecs: 900 }, transcription: transcription({ maxSeconds: PRIVATE_CAP }) });
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

  test("persisted size and duration failures use retry copy that fits both states", () => {
    for (const code of ["recording_too_large", "recording_too_long"]) {
      const html = render({
        item: { ...VOICE, durationSecs: 4_320 },
        metadata: { status: "ok", metadata: {
          transcription_outcome: "failed",
          transcription_error_code: code,
        } },
        transcript: { status: "absent" },
        transcription: transcription({ maxSeconds: PRIVATE_CAP }),
      });
      expect(html).toContain('data-testid="voice-note-transcription-failed"');
      expect(html).toContain("Private cloud couldn&#x27;t accept this recording&#x27;s length or size. Try again.");
      expect(html).toContain("Try again");
      expect(html).toContain('data-testid="transcribe-button"');
    }
  });
  test("a Private transcript storage refused: Manage storage, then Transcribe again; the local-audio line only with evidence the recording is here", () => {
    const persisted = (item: typeof VOICE) => render({
      item,
      metadata: { status: "ok", metadata: { transcription_outcome: "failed", transcription_error_code: "storage_full" } },
      transcript: { status: "absent" },
      transcription: transcription(),
    });
    const bare = persisted(VOICE);
    expect(bare).toContain("Transcribe it again when space is available.");
    expect(bare).not.toContain("safe on this device");
    expect(bare).toContain("Manage storage");
    expect(bare).toContain("Transcribe again");
    const withAudio = persisted({ ...VOICE, localAudioReady: true });
    expect(withAudio).toContain("Your recording is safe on this device.");
    expect(persisted({ ...VOICE, hasLocalAudio: true })).not.toContain("Your recording is safe on this device.");
    expect(withAudio).toContain("Manage storage");
    const live = render({ transcription: transcription({ jobs: new Map([["rec-1", { kind: "failed", code: "storage_full", message: "Your TinyCloud storage is full.", retryable: false, reference: null }]]) }) });
    expect(live).toContain("Transcribe it again when space is available.");
    expect(live).not.toContain("safe on this device");
    expect(live).toContain("Manage storage");
    expect(live).toContain("Transcribe again");
  });
  test("TC-1206: a persisted storage-full transcript takes precedence over a local Private-choice failure", () => {
    const html = render({
      metadata: { status: "ok", metadata: { transcription_outcome: "failed", transcription_error_code: "storage_full" } },
      transcript: { status: "absent" },
      transcription: transcription({ jobs: new Map([["rec-1", {
        kind: "failed", code: "private_choice_persistence_failed", message: "Could not save this Private choice.",
        retryable: true, reference: null,
      }]]) }),
    });
    expect(html).toContain("Transcribe it again when space is available.");
    expect(html).toContain("Manage storage");
    expect(html).not.toContain("Could not save this Private choice");
  });
  test("a persisted provider failure keeps its private-cloud re-upload sentence", () => {
    const html = render({
      metadata: { status: "ok", metadata: {
        transcription_outcome: "failed",
        transcription_error_code: "provider_unavailable",
      } },
      transcript: { status: "absent" },
      transcription: transcription({ availability: "checking", maxSeconds: null }),
    });
    expect(html).toContain("Private cloud transcription failed while transcribing. Retrying uploads the recording again.");
    expect(html).toContain('data-testid="transcribe-private-recheck"');
    expect(html).toContain("Check again");
  });
  test("persisted incomplete transcript is retryable with explicit may-be-incomplete copy", () => {
    const html = render({
      metadata: { status: "ok", metadata: {
        transcription_outcome: "failed",
        transcription_error_code: "transcript_incomplete",
      } },
      transcript: { status: "absent" },
      transcription: transcription({ maxSeconds: PRIVATE_CAP }),
    });
    expect(html).toContain("Private Transcription returned a transcript that may be incomplete. Try again later.");
    expect(html).toContain("Try again");
    expect(html).toContain('data-testid="transcribe-button"');
  });

  test("committed transcript reruns are offered only when commit provenance was read", () => {
    const committed = render({
      metadata: { status: "ok", metadata: { transcription_outcome: "no_speech" } },
      transcriptProvenance: { engine: "private-cloud", provider: "ptx" },
      transcription: transcription(),
    });
    expect(committed).toContain("No speech found");
    expect(committed).toContain('data-testid="voice-note-transcription-rerun"');
    expect(committed).toContain('data-testid="transcribe-button"');
    const legacy = render({
      metadata: { status: "ok", metadata: { transcription_outcome: "transcribed" } },
      transcript: { status: "ok", sentences: [] },
      transcriptProvenance: null,
      transcription: transcription(),
    });
    expect(legacy).not.toContain('data-testid="voice-note-transcription-rerun"');
    expect(legacy).not.toContain("Transcribe again");
  });

  test("a live incomplete failure keeps the mapped explanation and only offers a retry when allowed", () => {
    const failed = (retryable: boolean) => render({ transcription: transcription({ jobs: new Map([["rec-1", {
      kind: "failed", code: "transcript_incomplete", message: "Generic job error", retryable, reference: "cid-7",
    }]]) }) });
    const copy = "Private Transcription returned a transcript that may be incomplete. Try again later.";
    expect(failed(true)).toContain(copy);
    expect(failed(true)).toContain('data-testid="transcribe-button"');
    expect(failed(false)).toContain(copy);
    expect(failed(false)).not.toContain('data-testid="transcribe-button"');
  });

  test("a durable failure explains itself once below Transcript while the header keeps its state", () => {
    const pipeline = pipelineOf({ route: "off", hasNotesOrMoments: false,
      space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
      transcript: { inSpace: null, persistedState: "failed", errorCode: "transcript_incomplete", cloud: null, onDevice: null } });
    const view = { pipeline, onAction: noop, actionError: null };
    const html = renderToStaticMarkup(
      <NotePipelineContext.Provider value={view}>
        <MemoryRouter><NoteDetailView item={VOICE} listStatus="ready"
          metadata={{ status: "ok", metadata: { transcription_outcome: "failed", transcription_error_code: "transcript_incomplete" } }}
          transcript={{ status: "absent" }} audio={audio} transcription={transcription()} activityView={view} platform="ios"
          copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} /></MemoryRouter>
      </NotePipelineContext.Provider>,
    );
    expect(html).toContain("Transcript Failed");
    expect(html.match(/Private Transcription returned a transcript that may be incomplete/g)).toHaveLength(1);
    expect(html.match(/data-testid="transcribe-button"/g)).toHaveLength(1);
  });
  test("part progress, completed jobs, and retry eligibility are reflected accurately", () => {
    const job = (state: NoteTranscriptionState) => transcription({ jobs: new Map([["rec-1", state]]) });
    expect(render({ transcription: job({ kind: "active", status: { kind: "processing", completed: 1, total: 3 } }) })).toContain("1 of 3 parts done");
    expect(render({ transcription: job({ kind: "active", status: { kind: "processing", completed: 4, total: 9 } }) })).toContain('title="Recordings are transcribed in parts"');
    expect(render({ transcription: job({ kind: "active", status: { kind: "processing", completed: 9, total: 9 } }) })).toContain("9 of 9 parts done");
    expect(render({ transcription: job({ kind: "active", status: { kind: "processing", completed: 2, total: 0 } }) })).toContain("Transcribing");
    expect(render({ transcription: job({ kind: "done", outcome: "transcribed" }) })).toContain("Transcript saved.");
    const failed = (retryable: boolean) =>
      job({ kind: "failed", code: "upload_interrupted", message: "The upload did not complete.", retryable, reference: "cid-7" });
    const retry = render({ transcription: failed(true) });
    expect(retry).toContain("Reference: cid-7");
    expect(retry).toContain("Copy details");
    expect(retry).toContain("The upload did not complete.");
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
    expect(html).toContain("No speech found");
    expect(html).not.toContain("Transcript saved.");
  });

  test("the space's no-speech outcome wins without a local read error", () => {
    const html = withJob({ state: "done" }, { metadata: { status: "ok", metadata: { transcription_outcome: "no_speech" } }, localTranscript: null });
    expect(html).toContain("No speech found");
    expect(html).not.toContain("Couldn’t read the transcript saved on this Mac.");
  });

  test("an older device copy names a failed space read and offers retry", () => {
    const html = withJob({ state: "done" }, { localTranscript, transcript: { status: "failed", message: "offline" } });
    expect(html).toContain("Saved on this Mac");
    expect(html).toContain("On this device · Couldn’t check your space.");
    expect(html).toContain("Try again");
    const silent = withJob({ state: "done" }, { localTranscript: { ...localTranscript, outcome: "no_speech", segments: [] },
      transcript: { status: "failed", message: "offline" } });
    expect(silent).toContain("No speech found");
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

  test("PTX queued copy agrees in the detail and the home track summary", () => {
    const pipeline = pipelineOf({ space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
      transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "queued", position: 3 } } } });
    expect(transcriptStepLine(pipeline)).toBe("In the queue · #3");
    expect(pipelineTrackLabel(pipeline)).toContain("Transcript: In the queue · #3");
    expect(renderToStaticMarkup(<PipelineTrackSummary pipeline={pipeline} />)).toContain("Transcript: In the queue · #3");
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

const gap = { start: 41, end: 52, speaker_name: "Kenny Tucker" };
test("meeting gaps appear inline in time order with subtle accessible provenance labels", () => {
  const html = render({ item: MEETING, metadata: { status: "ok", metadata: { partial: true, gaps: [gap] } },
    transcript: { status: "ok", sentences: [
      { index: 0, speaker_name: null, text: "Before gap.", start_time: 30, end_time: 40, source: "fallback" },
      { index: 1, speaker_name: null, text: "After gap.", start_time: 53, end_time: 55, source: "recording" },
    ] } });
  expect(html).toContain("0:41–0:52 could not be transcribed — Kenny Tucker");
  expect(html.indexOf("Before gap.")).toBeLessThan(html.indexOf("0:41–0:52"));
  expect(html.indexOf("0:41–0:52")).toBeLessThan(html.indexOf("After gap."));
  expect(html).toContain("Fallback transcript");
  expect(html).toContain("Recovered from recording");
});

test("completed gaps-only meeting shows gaps instead of the empty state, omitting null speakers", () => {
  const html = render({ item: MEETING, metadata: { status: "ok", metadata: { partial: true,
    gaps: [gap, { start: 60, end: 70, speaker_name: null }] } } });
  expect(html).toContain("0:41–0:52 could not be transcribed — Kenny Tucker");
  expect(html).toContain("1:00–1:10 could not be transcribed</p>");
  expect(html).not.toContain("No transcript stored yet.");
});

test("legacy meeting transcript has no gap or provenance additions", () => {
  const html = render({ item: MEETING, metadata: { status: "ok", metadata: {} }, transcript: { status: "ok", sentences: [
    { index: 0, speaker_name: "Alice", text: "Legacy words.", start_time: 0, end_time: 1 },
  ] } });
  expect(html).toContain("Legacy words.");
  expect(html).not.toContain('data-testid="transcript-gap"');
  expect(html).not.toContain("Fallback transcript");
  expect(html).not.toContain("Recovered from recording");
});
