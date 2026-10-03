// The VOICE NOTES card. `VoiceNotesView` is a pure function of its props, so the product rules
// are asserted against real markup via react-dom/server (no DOM harness in this workspace):
//   1. idle says the microphone is off and offers Record;
//   2. recording shows the elapsed time and Stop;
//   3. what the OS reports is told, never hidden: silenced and no-signal read as warnings;
//   4. a load failure is not rendered as "no voice notes";
//   5. notes still only on the phone are told, with a way to save them;
//   6. outside the native app the section renders nothing;
//   7. transcription is offered only when available to this build AND account, and only after the
//      one-time private cloud consent; a hidden or still-checking engine shows nothing at all;
//   8. each note shows its transcript, its progress, or its failure (with Retry when it can help).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  VoiceNotesSection,
  VoiceNotesView,
  formatDuration,
  transcriptionProps,
  type VoiceNoteTranscriptionProps,
  type VoiceNotesViewProps,
} from "./VoiceNotesSection";
import type { VoiceNoteListItem } from "@/lib/voiceNotes/voiceNoteStore";
import type { NoteTranscriptionState } from "@/lib/voiceNotes/voiceNoteTranscription";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const noop = () => {};

function note(patch: Partial<VoiceNoteListItem> = {}): VoiceNoteListItem {
  return {
    id: "row-1",
    sourceId: "rec-1",
    title: "Voice note · Sep 29, 5:40 AM",
    startedAt: "2026-09-29T05:40:00.000Z",
    durationSecs: 12,
    transcript: { status: "none", preview: null },
    ...patch,
  };
}

function transcription(patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps {
  return {
    availability: "available",
    consented: true,
    maxSeconds: 600,
    jobs: new Map(),
    onTranscribe: noop,
    onConsent: noop,
    onTurnOff: noop,
    onRecheck: noop,
    ...patch,
  };
}

function render(patch: Partial<VoiceNotesViewProps> = {}): string {
  return renderToStaticMarkup(
    <VoiceNotesView
      phase="idle"
      mic={{ state: "idle", reason: null }}
      elapsedMs={0}
      level={0}
      error={null}
      notes={[]}
      notesStatus="ready"
      playing={null}
      pendingCount={0}
      retrying={false}
      onRecord={noop}
      onStop={noop}
      onPlay={noop}
      onRetry={noop}
      {...patch}
    />,
  );
}

describe("VoiceNotesView", () => {
  test("idle offers Record and says the microphone is off", () => {
    const html = render();
    expect(html).toContain('data-testid="voice-note-record"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
    expect(html).toContain("Not recording. The microphone is off.");
    expect(html).toContain("No voice notes yet.");
  });

  test("recording shows elapsed time and Stop", () => {
    const html = render({ phase: "recording", mic: { state: "recording", reason: null }, elapsedMs: 65_000 });
    expect(html).toContain('data-testid="voice-note-stop"');
    expect(html).toContain('data-mic-state="recording"');
    expect(html).toContain("Recording 1:05");
  });

  test("an OS-silenced capture is a visible warning, not a normal recording", () => {
    const html = render({ phase: "recording", mic: { state: "silenced", reason: "os_silenced" }, elapsedMs: 3_000 });
    expect(html).toContain('data-mic-state="silenced"');
    expect(html).toContain("the system is blocking the microphone");
  });

  test("zero input level while live says no sound is arriving", () => {
    const html = render({ phase: "recording", mic: { state: "recording", reason: "no_signal" }, elapsedMs: 3_000 });
    expect(html).toContain('data-mic-reason="no_signal"');
    expect(html).toContain("no sound is reaching the microphone");
  });

  test("a failed list load is told, never shown as an empty list", () => {
    const html = render({ notesStatus: "error" });
    expect(html).toContain("Could not load your voice notes.");
    expect(html).not.toContain("No voice notes yet.");
  });

  test("saved notes list with duration, and the open one gets a player", () => {
    const html = render({
      notes: [note()],
      playing: { sourceId: "rec-1", src: "data:audio/mp4;base64,AAAA" },
    });
    expect(html).toContain('data-source-id="rec-1"');
    expect(html).toContain("0:12");
    expect(html).toContain('data-testid="voice-note-player"');
  });
});

describe("VoiceNotesView pending saves", () => {
  test("nothing pending shows no banner", () => {
    expect(render()).not.toContain('data-testid="voice-note-pending"');
  });

  test("notes left on the phone are told, with Save now", () => {
    const one = render({ pendingCount: 1 });
    expect(one).toContain("1 note is on this phone but not yet in your");
    expect(one).toContain('data-testid="voice-note-retry"');
    expect(render({ pendingCount: 3 })).toContain("3 notes are on this phone");
  });

  test("Save now is disabled while a retry runs", () => {
    expect(render({ pendingCount: 1, retrying: true })).toMatch(/<button[^>]*disabled[^>]*data-testid="voice-note-retry"/);
  });
});

describe("formatDuration", () => {
  test("minutes and zero-padded seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9_999)).toBe("0:09");
    expect(formatDuration(600_000)).toBe("10:00");
  });
});

describe("VoiceNotesSection", () => {
  test("renders nothing outside the Exo mobile app", () => {
    expect(renderToStaticMarkup(<VoiceNotesSection tcw={{} as TinyCloudWeb} />)).toBe("");
  });
});

describe("VoiceNotesView transcription", () => {
  const TRANSCRIBE_UI = [
    'data-testid="voice-note-transcribe"',
    'data-testid="voice-note-transcription-consent"',
    'data-testid="voice-note-transcription-on"',
    'data-testid="voice-note-transcription-unavailable"',
    "private cloud",
  ];
  const offersNothing = (html: string) => {
    for (const marker of TRANSCRIBE_UI) expect(html).not.toContain(marker);
  };

  test("a build without a PTX origin, a dark/out-of-cohort account, or a pending check offers nothing", () => {
    offersNothing(render({ notes: [note()] }));
    offersNothing(render({ notes: [note()], transcription: transcription({ availability: "hidden" }) }));
    offersNothing(render({ notes: [note()], transcription: transcription({ availability: "checking" }) }));
    // A failed check is told only to someone who already chose private cloud.
    offersNothing(render({ notes: [note()], transcription: transcription({ availability: "failed", consented: false }) }));
    const failed = render({ notes: [note()], transcription: transcription({ availability: "failed", consented: true }) });
    expect(failed).toContain('data-testid="voice-note-transcription-unavailable"');
    expect(failed).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("available but not consented: the disclosure and Use private cloud, no per-note Transcribe yet", () => {
    const html = render({ notes: [note()], transcription: transcription({ consented: false }) });
    expect(html).toContain('data-testid="voice-note-transcription-consent"');
    expect(html).toContain("TinyCloud Private Transcription");
    expect(html).toContain("Tinfoil");
    expect(html).toContain("It never receives your audio.");
    expect(html).toContain("notes up to 10 minutes");
    expect(html).toContain("The voice note&#x27;s audio stays in your TinyCloud space");
    expect(html).not.toMatch(/verified|attested|end-to-end/i);
    expect(html).toContain('data-testid="voice-note-transcription-enable"');
    expect(html).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("consented: each untranscribed note offers Transcribe; a note over the limit says so instead", () => {
    const html = render({
      notes: [note(), note({ id: "row-2", sourceId: "rec-long", durationSecs: 900 })],
      transcription: transcription(),
    });
    expect(html).toContain('data-testid="voice-note-transcription-on"');
    expect(html.match(/data-testid="voice-note-transcribe"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="voice-note-too-long"');
    expect(html).toContain("Notes up to 10 minutes can be transcribed from the phone.");
  });

  test("a transcribed note shows its transcript whatever the engine's state; no speech is told", () => {
    const transcribed = note({ transcript: { status: "transcribed", preview: "Book the venue." } });
    for (const t of [undefined, transcription({ availability: "hidden" }), transcription()]) {
      const html = render({ notes: [transcribed], transcription: t });
      expect(html).toContain('data-testid="voice-note-transcript"');
      expect(html).toContain("Book the venue.");
      expect(html).not.toContain('data-testid="voice-note-transcribe"');
    }
    const silent = render({ notes: [note({ transcript: { status: "no_speech", preview: null } })], transcription: transcription() });
    expect(silent).toContain("No speech was found in this note.");
    expect(silent).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("just saved, before the list catches up: told as saved, never offered Transcribe again", () => {
    for (const [outcome, text] of [["transcribed", "Transcript saved."], ["no_speech", "No speech was found in this note."]] as const) {
      const jobs = new Map<string, NoteTranscriptionState>([["rec-1", { kind: "done", outcome }]]);
      const html = render({ notes: [note()], transcription: transcription({ jobs }) });
      expect(html).toContain('data-testid="voice-note-transcription-done"');
      expect(html).toContain(text);
      expect(html).not.toContain('data-testid="voice-note-transcribe"');
    }
  });

  test("transcriptionProps: no transcriber, no transcription UI; otherwise the snapshot drives it", () => {
    expect(transcriptionProps(null, { availability: "available", capabilities: null, consented: true, jobs: new Map() })).toBeUndefined();
    const calls: string[] = [];
    const fake = {
      transcribe: (id: string) => calls.push(`transcribe:${id}`),
      consent: () => calls.push("consent"),
      turnOff: async () => void calls.push("turnOff"),
      check: async () => void calls.push("check"),
    } as never;
    const props = transcriptionProps(fake, { availability: "available", capabilities: { max_bytes: 1, max_duration_seconds: 120 }, consented: true, jobs: new Map() })!;
    expect(props).toMatchObject({ availability: "available", consented: true, maxSeconds: 120 });
    props.onTranscribe("rec-9");
    props.onConsent();
    props.onTurnOff();
    props.onRecheck();
    expect(calls).toEqual(["transcribe:rec-9", "consent", "turnOff", "check"]);
  });

  test("a note being transcribed shows its progress instead of Transcribe", () => {
    const jobs = new Map<string, NoteTranscriptionState>([["rec-1", { kind: "active", status: { kind: "processing", completed: 1, total: 3 } }]]);
    const html = render({ notes: [note()], transcription: transcription({ jobs }) });
    expect(html).toContain('data-testid="voice-note-transcription-status"');
    expect(html).toContain("Transcribing in private cloud… 1/3");
    expect(html).not.toContain('data-testid="voice-note-transcribe"');
  });

  test("a failed attempt is told with its reference; Retry only when it can help and transcription is on", () => {
    const failed = (retryable: boolean) =>
      new Map<string, NoteTranscriptionState>([
        ["rec-1", { kind: "failed", code: "upload_interrupted", message: "The upload did not complete.", retryable, reference: "cid-7" }],
      ]);
    const retry = render({ notes: [note()], transcription: transcription({ jobs: failed(true) }) });
    expect(retry).toContain("The upload did not complete.");
    expect(retry).toContain("Reference: cid-7");
    expect(retry).toContain('data-testid="voice-note-transcribe-retry"');
    expect(render({ notes: [note()], transcription: transcription({ jobs: failed(false) }) })).not.toContain(
      'data-testid="voice-note-transcribe-retry"',
    );
    expect(render({ notes: [note()], transcription: transcription({ jobs: failed(true), availability: "failed" }) })).not.toContain(
      'data-testid="voice-note-transcribe-retry"',
    );
  });
});
