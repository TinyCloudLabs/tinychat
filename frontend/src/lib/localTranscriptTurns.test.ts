// Speaker turns for local recordings. Fixtures are synthetic and timed the way
// whisper-local times real output: each VAD chunk's words are spread evenly
// across the chunk (see chunk()), so word times are only chunk-accurate.
//
// Asserted behavior:
//   - channels are segmented on their own and ordered by start time, so
//     simultaneous speech never interleaves word by word;
//   - consecutive same-speaker segments merge into one turn, capped at
//     MAX_TURN_SECONDS;
//   - mic phrases that substantially repeat system audio from the same moment
//     are dropped (kept as Others), including Whisper-garbled echo, once the
//     recording shows echo throughout;
//   - distinct mic speech is kept: overlapping different speech, shared
//     function words or backchannels, lone-word replies, a repeat after the
//     echo was matched, the same words outside the echo window, verbatim
//     confirmations on a headphone call, a single echo-like phrase;
//   - one-channel, empty, channel-less, and extra-channel recordings.

import { describe, expect, test } from "bun:test";

import {
  ECHO_MIN_SHARE,
  findMicEcho,
  localChannelLabel,
  localTranscriptTurns,
  MAX_TURN_SECONDS,
  MIC_CHANNEL,
  SYSTEM_CHANNEL,
  type LocalWord,
} from "./localTranscriptTurns";

const MIC = MIC_CHANNEL;
const SYS = SYSTEM_CHANNEL;

/** One VAD chunk: its words spread evenly over [start, end], like whisper-local. */
function chunk(channel: number | undefined, start: number, end: number, text: string): LocalWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const duration = end - start;
  return parts.map((t, i) => {
    const wordStart = start + (i / parts.length) * duration;
    return {
      text: t,
      start: wordStart,
      end: i + 1 === parts.length
        ? Math.max(start + duration - 0.1, wordStart + 0.05)
        : start + ((i + 1) / parts.length) * duration,
      channel,
    };
  });
}

/** A recording's words, sorted by start time as collectWords() returns them. */
function recording(...chunks: LocalWord[][]): LocalWord[] {
  return chunks.flat().sort((a, b) => a.start - b.start);
}

function lines(words: LocalWord[]): string[] {
  return localTranscriptTurns(words).map((s) => `${s.speaker_name}: ${s.text}`);
}

describe("localChannelLabel", () => {
  test("mic is You, system audio is Others, other channels are numbered", () => {
    expect(localChannelLabel(MIC)).toBe("You");
    expect(localChannelLabel(SYS)).toBe("Others");
    expect(localChannelLabel(2)).toBe("Speaker 3");
    expect(localChannelLabel(undefined)).toBeNull();
  });
});

describe("localTranscriptTurns: echo", () => {
  test("mic echo of system audio is dropped and the words stay with Others (no word-by-word interleave)", () => {
    const text = "Ship the release on Thursday. Blue kites fly over the harbor.";
    const words = recording(chunk(SYS, 0, 6, text), chunk(MIC, 0.3, 6.2, text));

    expect(lines(words)).toEqual([`Others: ${text}`]);
    expect(findMicEcho(words).size).toBe(11);
  });

  test("echo that Whisper garbled on the mic still matches when most words align in order", () => {
    const words = recording(
      chunk(SYS, 0, 6, "Ship the release on Thursday. Purple elephants dance on Tuesday."),
      // "releases" and "elephant" fold plurals; "prance" is a mishearing.
      chunk(MIC, 0.2, 6.3, "Ship the releases on Thursday. Purple elephant prance on Tuesday."),
    );

    expect(lines(words)).toEqual(["Others: Ship the release on Thursday. Purple elephants dance on Tuesday."]);
  });

  test("echo too garbled to align is kept on both channels", () => {
    const words = recording(
      chunk(SYS, 0, 3, "Purple elephants dance on Tuesday."),
      chunk(MIC, 0.1, 3.2, "Perfect. I look for the dance on."),
    );

    expect(lines(words)).toEqual([
      "Others: Purple elephants dance on Tuesday.",
      "You: Perfect. I look for the dance on.",
    ]);
  });

  test("only the echoed phrase is dropped from a mic segment; speech on either side keeps its place", () => {
    const words = recording(
      // 15 words over 12 s: the echoed sentence falls at 2.4–6.4 s.
      chunk(MIC, 0, 12, "Good morning everyone. Ship the release on Thursday. Let us begin with the demo."),
      chunk(SYS, 2.6, 6.6, "Ship the release on Thursday."),
      chunk(SYS, 20, 23, "Blue kites fly over the harbor."),
      chunk(MIC, 20.2, 23.1, "Blue kites fly over the harbor."),
    );

    expect(lines(words)).toEqual([
      "You: Good morning everyone.",
      "Others: Ship the release on Thursday.",
      "You: Let us begin with the demo.",
      "Others: Blue kites fly over the harbor.",
    ]);
  });

  test("echo inside a mixed mic chunk is dropped when chunk timing offsets it by a couple of seconds", () => {
    const words = recording(
      // The mic chunk starts earlier with the user's own speech, so the echo's
      // evenly spread word times land ~2 s before the system-audio original.
      chunk(MIC, 0, 8, "I can hear you now. Blue kites fly over the harbor."),
      chunk(SYS, 5.5, 9.5, "Blue kites fly over the harbor."),
      chunk(SYS, 20, 23, "Ship the release on Thursday."),
      chunk(MIC, 20.1, 23.2, "Ship the release on Thursday."),
    );

    expect(lines(words)).toEqual([
      "You: I can hear you now.",
      "Others: Blue kites fly over the harbor. Ship the release on Thursday.",
    ]);
  });
});

describe("localTranscriptTurns: distinct speech is never dropped", () => {
  test("different speech at the same time is kept, one turn per speaker, ordered by start", () => {
    const words = recording(
      chunk(MIC, 10, 14, "Can you send me the deck after this call?"),
      chunk(SYS, 10.5, 14.5, "Sure, I will send the deck right after lunch."),
    );

    expect(lines(words)).toEqual([
      "You: Can you send me the deck after this call?",
      "Others: Sure, I will send the deck right after lunch.",
    ]);
  });

  test("simultaneous agreement made of backchannels and function words is kept", () => {
    const words = recording(
      chunk(SYS, 0, 2, "Okay, sounds good to me."),
      chunk(MIC, 0.1, 2.2, "Yeah, okay, sounds good to me."),
    );

    expect(findMicEcho(words).size).toBe(0);
    expect(lines(words)).toEqual([
      "Others: Okay, sounds good to me.",
      "You: Yeah, okay, sounds good to me.",
    ]);
  });

  test("overlap in function words alone is not echo", () => {
    const words = recording(
      chunk(SYS, 0, 3, "and then on the"),
      chunk(MIC, 0, 3, "and then on the other hand"),
    );

    expect(findMicEcho(words).size).toBe(0);
  });

  test("a lone-word reply is kept, even in a recording with echo", () => {
    const words = recording(
      chunk(SYS, 0, 3, "Ship the release on Thursday."),
      chunk(MIC, 0.2, 3.1, "Ship the release on Thursday."),
      chunk(SYS, 5, 8, "Blue kites fly over the harbor."),
      chunk(MIC, 5.2, 8.1, "Blue kites fly over the harbor."),
      chunk(SYS, 20, 22, "Monday or Friday?"),
      chunk(MIC, 22.3, 22.8, "Friday."),
    );

    expect(lines(words)).toEqual([
      "Others: Ship the release on Thursday. Blue kites fly over the harbor. Monday or Friday?",
      "You: Friday.",
    ]);
  });

  test("verbatim confirmations on a headphone call are kept: the far side's speech shows no echo", () => {
    const agenda = Array.from({ length: 15 }, (_, i) =>
      chunk(SYS, 100 + i * 10, 103 + i * 10, `Agenda item ${i + 1} covers budget planning.`),
    );
    const words = recording(
      ...agenda,
      chunk(SYS, 10, 12, "Friday at noon?"),
      chunk(MIC, 12.4, 13.4, "Friday at noon."),
      chunk(SYS, 20, 22, "Meet on the third floor?"),
      chunk(MIC, 22.3, 23.3, "Third floor."),
    );

    // Both confirmations look like echo on their own, but 2 of 17 echoable
    // system-audio phrases is below the share a speaker setup produces.
    expect(2 / 17).toBeLessThan(ECHO_MIN_SHARE);
    expect(findMicEcho(words).size).toBe(0);
    expect(lines(words).slice(0, 4)).toEqual([
      "Others: Friday at noon?",
      "You: Friday at noon.",
      "Others: Meet on the third floor?",
      "You: Third floor.",
    ]);
  });

  test("a single echo-like phrase is not enough evidence: both copies are kept", () => {
    const text = "Ship the release on Thursday.";
    const words = recording(chunk(SYS, 0, 3, text), chunk(MIC, 0.2, 3.1, text));

    expect(findMicEcho(words).size).toBe(0);
    expect(lines(words)).toEqual([`Others: ${text}`, `You: ${text}`]);
  });

  test("a repeat after the echo was matched is kept: each system word explains one mic phrase", () => {
    const words = recording(
      chunk(SYS, 0, 3, "Ship the release on Thursday."),
      chunk(MIC, 0.2, 3.1, "Ship the release on Thursday."),
      chunk(SYS, 30, 33, "Deploy the canary tonight."),
      chunk(MIC, 30.2, 33.1, "Deploy the canary tonight."),
      chunk(MIC, 34, 36, "Deploy the canary tonight?"),
    );

    expect(lines(words)).toEqual([
      "Others: Ship the release on Thursday. Deploy the canary tonight.",
      "You: Deploy the canary tonight?",
    ]);
  });

  test("the same words well outside the echo window are kept", () => {
    const words = recording(
      chunk(SYS, 0, 3, "Blue kites fly over the harbor."),
      chunk(MIC, 40, 43, "Blue kites fly over the harbor."),
    );

    expect(lines(words)).toEqual([
      "Others: Blue kites fly over the harbor.",
      "You: Blue kites fly over the harbor.",
    ]);
  });

  test("system audio is never dropped, even when the mic carries the same words", () => {
    const text = "Ship the release on Thursday. Blue kites fly over the harbor.";
    const words = recording(chunk(MIC, 0, 3, text), chunk(SYS, 0.2, 3.1, text));
    const turns = localTranscriptTurns(words);

    expect(turns.map((s) => s.speaker_name)).toEqual(["Others"]);
    for (const w of findMicEcho(words)) expect(w.channel).toBe(MIC);
  });
});

describe("localTranscriptTurns: turns", () => {
  test("consecutive same-speaker segments merge; a turn from the other side separates them", () => {
    const words = recording(
      chunk(MIC, 0, 3, "First point."),
      // 2 s pause: a new segment, but still the same speaker's turn.
      chunk(MIC, 5, 8, "Second point."),
      chunk(SYS, 9, 12, "Got it, thanks."),
      chunk(MIC, 13, 16, "Third point."),
    );

    const turns = localTranscriptTurns(words);
    expect(turns.map((s) => `${s.speaker_name}: ${s.text}`)).toEqual([
      "You: First point. Second point.",
      "Others: Got it, thanks.",
      "You: Third point.",
    ]);
    expect(turns.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(turns[0]).toMatchObject({ start_time: 0, end_time: 7.9 });
  });

  test(`a long monologue splits into turns spanning at most ${MAX_TURN_SECONDS} s`, () => {
    const chunks = Array.from({ length: 8 }, (_, i) => chunk(MIC, i * 20, i * 20 + 18, `Part ${i + 1} of the talk.`));
    const turns = localTranscriptTurns(recording(...chunks));

    expect(turns.length).toBeGreaterThan(1);
    for (const t of turns) {
      expect(t.speaker_name).toBe("You");
      expect(t.end_time - t.start_time).toBeLessThanOrEqual(MAX_TURN_SECONDS);
    }
    expect(turns.map((t) => t.text).join(" ")).toBe(
      Array.from({ length: 8 }, (_, i) => `Part ${i + 1} of the talk.`).join(" "),
    );
  });

  test("a mic-only recording is all You, merged into one turn", () => {
    const words = recording(chunk(MIC, 0, 3, "Testing one two."), chunk(MIC, 6, 9, "Still testing."));
    expect(lines(words)).toEqual(["You: Testing one two. Still testing."]);
  });

  test("a system-audio-only recording is all Others", () => {
    const words = recording(chunk(SYS, 0, 3, "Welcome to the webinar."), chunk(SYS, 4, 6, "Let us start."));
    expect(lines(words)).toEqual(["Others: Welcome to the webinar. Let us start."]);
  });

  test("words without a channel keep a null speaker and are never matched as echo", () => {
    const text = "Ship the release on Thursday.";
    const words = recording(chunk(undefined, 0, 3, text), chunk(SYS, 0.1, 3.1, text));

    expect(findMicEcho(words).size).toBe(0);
    expect(localTranscriptTurns(words).map((s) => [s.speaker_name, s.text])).toEqual([
      [null, text],
      ["Others", text],
    ]);
  });

  test("a third channel is numbered and never treated as the mic", () => {
    const text = "Ship the release on Thursday.";
    const words = recording(chunk(2, 0, 3, text), chunk(SYS, 0.1, 3.1, text));

    expect(lines(words)).toEqual([`Speaker 3: ${text}`, `Others: ${text}`]);
  });

  test("no words yield no turns", () => {
    expect(localTranscriptTurns([])).toEqual([]);
    expect(findMicEcho([]).size).toBe(0);
  });
});
