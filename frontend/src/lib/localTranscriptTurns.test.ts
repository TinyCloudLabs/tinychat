// Speaker turns for local recordings. Fixtures are synthetic and timed the way
// whisper-local times real output: each VAD chunk's words are spread evenly
// across the chunk (see chunk()), so word times are only chunk-accurate.
//
// Asserted behavior:
//   - channels are segmented on their own and ordered by start time, so
//     simultaneous speech never interleaves word by word;
//   - consecutive same-speaker segments merge into one turn, and no turn
//     (continuous speech included) spans more than MAX_TURN_SECONDS;
//   - a mic chunk whose every word repeats system audio from the same moment
//     is dropped whole (kept as Others), tolerating plurals and words Whisper
//     dropped, once the recording shows a stable small echo lag;
//   - part of a mic chunk is never dropped: echo mixed with the user's own
//     words in one chunk, in either order, keeps the whole chunk, including a
//     lone confirmation ("Yes.", "No.", "Okay.", "Sure.") or an extra word;
//   - distinct mic speech is kept: overlapping different speech, shared
//     function words or backchannels, lone-word replies, immediate verbatim
//     repetitions in a recording with echo (in their own chunk or sharing a
//     chunk with other words), a repeat after the echo was matched, long
//     phrases repeated seconds apart, echo-like text off the recording's echo
//     lag, confirmations on a headphone call, a single echo-like chunk;
//   - one-channel, empty, channel-less, and extra-channel recordings;
//   - an 8-hour recording and collapsed timestamps finish quickly, and
//     collapsed timestamps drop nothing.

import { describe, expect, test } from "bun:test";

import {
  ECHO_MAX_CANDIDATES,
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

/** Two clean echo chunks (mic 0.2 s behind system audio) starting at `at`:
 *  enough to open the echo gate and measure the recording's echo lag. */
function cleanEchoes(at: number): LocalWord[][] {
  return [
    chunk(SYS, at, at + 3, "Ship the release on Thursday."),
    chunk(MIC, at + 0.2, at + 3.1, "Ship the release on Thursday."),
    chunk(SYS, at + 5, at + 8, "Blue kites fly over the harbor."),
    chunk(MIC, at + 5.2, at + 8.1, "Blue kites fly over the harbor."),
  ];
}

/** 32 words without punctuation: one long phrase. */
const LONG_PHRASE = (
  "quarterly revenue grew across every region while hiring stayed flat and the board asked "
  + "for a clearer plan covering pricing churn support costs partner margins and the launch "
  + "schedule for next spring"
);

function micWordsBetween(words: Iterable<LocalWord>, from: number, to: number): LocalWord[] {
  return [...words].filter((w) => w.channel === MIC && w.start >= from && w.start < to);
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
    const first = "Ship the release on Thursday. Blue kites fly over the harbor.";
    const second = "Deploy the canary build tonight.";
    const words = recording(
      chunk(SYS, 0, 6, first),
      chunk(MIC, 0.3, 6.2, first),
      chunk(SYS, 8, 11, second),
      chunk(MIC, 8.2, 11.1, second),
    );

    expect(lines(words)).toEqual([`Others: ${first} ${second}`]);
    expect(findMicEcho(words).size).toBe(16);
  });

  test("echo with plurals or words Whisper dropped on the mic still matches", () => {
    const words = recording(
      chunk(SYS, 0, 3, "Ship the release on Thursday."),
      // "releases" folds to "release"; Whisper dropped "the".
      chunk(MIC, 0.2, 3.1, "Ship releases on Thursday."),
      chunk(SYS, 5, 8, "Purple elephants dance on Tuesday."),
      chunk(MIC, 5.2, 8.1, "Purple elephant dance Tuesday."),
    );

    expect(lines(words)).toEqual(["Others: Ship the release on Thursday. Purple elephants dance on Tuesday."]);
  });

  test("a mic chunk with any word the system audio does not explain is kept whole", () => {
    const words = recording(
      ...cleanEchoes(0),
      chunk(SYS, 10, 13, "Purple elephants dance on Tuesday."),
      // One extra "the": it could be the user's.
      chunk(MIC, 10.2, 13.1, "Purple elephants dance on the Tuesday."),
    );

    expect(findMicEcho(words).size).toBe(11);
    expect(lines(words)).toEqual([
      "Others: Ship the release on Thursday. Blue kites fly over the harbor. Purple elephants dance on Tuesday.",
      "You: Purple elephants dance on the Tuesday.",
    ]);
  });

  test("a confirmation sharing a chunk with echo keeps the whole chunk, in either order", () => {
    const echoed = "Deploy the canary build tonight.";
    for (const answer of ["Yes.", "No.", "Okay.", "Sure."]) {
      for (const micText of [`${echoed} ${answer}`, `${answer} ${echoed}`]) {
        const words = recording(
          ...cleanEchoes(100),
          chunk(SYS, 0, 3, echoed),
          // One VAD chunk: the echo and the user's answer, word times spread evenly.
          chunk(MIC, 0.1, 3.6, micText),
        );

        expect(micWordsBetween(findMicEcho(words), 0, 10)).toHaveLength(0);
        expect(micWordsBetween(findMicEcho(words), 100, 110)).toHaveLength(11);
        expect(lines(words)[0]).toBe(`Others: ${echoed}`);
        expect(lines(words)).toContain(`You: ${micText}`);
      }
    }
  });

  test("a mic chunk with one misheard content word is kept whole", () => {
    const words = recording(
      ...cleanEchoes(0),
      chunk(SYS, 10, 13, "Purple elephants dance on Tuesday."),
      // "prance" explains nothing on the system side: it could be the user.
      chunk(MIC, 10.2, 13.1, "Purple elephants prance on Tuesday."),
    );

    expect(findMicEcho(words).size).toBe(11);
    expect(lines(words)).toEqual([
      "Others: Ship the release on Thursday. Blue kites fly over the harbor. Purple elephants dance on Tuesday.",
      "You: Purple elephants prance on Tuesday.",
    ]);
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

  test("an echo chunk between the user's own chunks is dropped; their speech keeps its place", () => {
    const words = recording(
      chunk(MIC, 0, 2, "Good morning everyone."),
      chunk(SYS, 2.6, 5.6, "Ship the release on Thursday."),
      chunk(MIC, 2.8, 5.7, "Ship the release on Thursday."),
      chunk(MIC, 7, 10, "Let us begin with the demo."),
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

  test("echo mixed with the user's own words in one chunk keeps the whole chunk, in either order", () => {
    const echoThenUser = recording(
      ...cleanEchoes(100),
      chunk(SYS, 0, 3, "Deploy the canary build tonight."),
      // One VAD chunk: the echo, then the user. Word times spread evenly.
      chunk(MIC, 0.2, 5, "Deploy the canary build tonight. I will check."),
    );
    const userThenEcho = recording(
      ...cleanEchoes(100),
      chunk(SYS, 2, 5, "Deploy the canary build tonight."),
      // One VAD chunk: the user, then the echo.
      chunk(MIC, 0, 5.1, "I will check. Deploy the canary build tonight."),
    );

    for (const words of [echoThenUser, userThenEcho]) {
      expect(micWordsBetween(findMicEcho(words), 0, 10)).toHaveLength(0);
      expect(micWordsBetween(findMicEcho(words), 100, 110)).toHaveLength(11);
    }
    expect(lines(echoThenUser).slice(0, 2)).toEqual([
      "Others: Deploy the canary build tonight.",
      "You: Deploy the canary build tonight. I will check.",
    ]);
    expect(lines(userThenEcho).slice(0, 2)).toEqual([
      "You: I will check. Deploy the canary build tonight.",
      "Others: Deploy the canary build tonight.",
    ]);
  });

  test("echo-like text off the recording's echo lag is kept on both channels", () => {
    const words = recording(
      // The mic chunk starts earlier with the user's own speech, so the echo's
      // evenly spread word times land ~1.9 s before the system-audio original:
      // indistinguishable from a repetition, so it is kept.
      chunk(MIC, 0, 8, "I can hear you now. Deploy the canary build tonight."),
      chunk(SYS, 5.5, 9.5, "Deploy the canary build tonight."),
      ...cleanEchoes(20),
    );

    expect(lines(words)).toEqual([
      "You: I can hear you now. Deploy the canary build tonight.",
      "Others: Deploy the canary build tonight. Ship the release on Thursday. Blue kites fly over the harbor.",
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

  test("a reply sharing a chunk with the user's other words survives, even when timing makes it look like echo", () => {
    // Two real echoes elsewhere; then the user's VAD chunk spans 8–13 s, so its
    // evenly spread word times put "Friday at noon." right on top of the
    // system-audio question at 10–12 s.
    const words = recording(
      ...cleanEchoes(100),
      chunk(SYS, 10, 12, "Friday at noon?"),
      chunk(MIC, 8, 13, "I will check. Friday at noon."),
    );

    expect(micWordsBetween(findMicEcho(words), 0, 20)).toHaveLength(0);
    expect(lines(words).slice(0, 2)).toEqual([
      "You: I will check. Friday at noon.",
      "Others: Friday at noon?",
    ]);
  });

  test("immediate verbatim repetitions survive in a recording with echo", () => {
    const words = recording(
      ...cleanEchoes(0),
      // Not echoed on the mic; the user confirms right after.
      chunk(SYS, 10, 12, "Friday at noon?"),
      chunk(MIC, 12.3, 13.3, "Friday at noon."),
      // Echoed on the mic, then confirmed.
      chunk(SYS, 20, 22.5, "Meet on the third floor?"),
      chunk(MIC, 20.2, 22.6, "Meet on the third floor?"),
      chunk(MIC, 23.2, 24, "Third floor."),
      // Repeated in full, starting 0.1 s after the other side stops.
      chunk(SYS, 30, 33, "Send the budget draft tonight."),
      chunk(MIC, 33.1, 35.5, "Send the budget draft tonight."),
    );

    expect(lines(words)).toEqual([
      "Others: Ship the release on Thursday. Blue kites fly over the harbor. Friday at noon?",
      "You: Friday at noon.",
      "Others: Meet on the third floor?",
      "You: Third floor.",
      "Others: Send the budget draft tonight.",
      "You: Send the budget draft tonight.",
    ]);
  });

  test("a long phrase repeated 10 s later is kept, word timing checked per word", () => {
    const words = recording(
      chunk(SYS, 0, 20, LONG_PHRASE),
      chunk(MIC, 10, 30, LONG_PHRASE),
      ...cleanEchoes(100),
    );
    const echo = findMicEcho(words);

    expect(micWordsBetween(words, 10, 30)).toHaveLength(32);
    expect(micWordsBetween(echo, 10, 30)).toHaveLength(0);
    // The real echoes elsewhere are still dropped.
    expect(micWordsBetween(echo, 100, 110)).toHaveLength(11);
  });

  test("long overlapping phrases staggered by 2.5 s are kept", () => {
    const words = recording(
      chunk(SYS, 0, 20, LONG_PHRASE),
      chunk(MIC, 2.5, 22.5, LONG_PHRASE),
      ...cleanEchoes(100),
    );

    expect(micWordsBetween(findMicEcho(words), 0, 30)).toHaveLength(0);
  });

  test("a single echo-like chunk is not enough evidence: both copies are kept", () => {
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
    const words = recording(...cleanEchoes(0));
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

  test(`continuous 120 s speech is split at word boundaries into turns of at most ${MAX_TURN_SECONDS} s`, () => {
    // Back-to-back 20 s chunks: 0.1 s between them, never a segment-ending pause.
    const texts = Array.from({ length: 6 }, (_, i) => `Section ${i + 1} walks through the plan in detail.`);
    const turns = localTranscriptTurns(recording(...texts.map((t, i) => chunk(SYS, i * 20, i * 20 + 20, t))));

    expect(turns.length).toBeGreaterThanOrEqual(2);
    for (const t of turns) {
      expect(t.speaker_name).toBe("Others");
      expect(t.end_time - t.start_time).toBeLessThanOrEqual(MAX_TURN_SECONDS);
    }
    expect(turns.map((t) => t.text).join(" ")).toBe(texts.join(" "));
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

describe("localTranscriptTurns: scale", () => {
  const SENTENCES = [
    "Ship the release on Thursday.",
    "Blue kites fly over the harbor.",
    "Deploy the canary build tonight.",
    "Review the budget draft with finance.",
    "Purple elephants dance on Tuesday.",
    "Green bicycles race on Friday.",
  ];

  test("an 8-hour continuous call with echo: echo dropped, every turn at most 60 s, fast", () => {
    // Back-to-back 24 s system-audio chunks for 8 h, each echoed on the mic.
    const chunks: LocalWord[][] = [];
    for (let at = 0; at < 8 * 3600; at += 24) {
      const text = Array.from({ length: 12 }, (_, i) => SENTENCES[(at / 24 + i) % SENTENCES.length]).join(" ");
      chunks.push(chunk(SYS, at, at + 24, text), chunk(MIC, at + 0.2, at + 24.2, text));
    }
    const words = recording(...chunks);
    expect(words.length).toBeGreaterThan(140_000);

    const started = performance.now();
    const turns = localTranscriptTurns(words);
    const elapsed = performance.now() - started;

    expect(turns.every((t) => t.speaker_name === "Others")).toBe(true);
    expect(turns.every((t) => t.end_time - t.start_time <= MAX_TURN_SECONDS)).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(8 * 60);
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  test(`collapsed timestamps: more than ${ECHO_MAX_CANDIDATES} candidates keeps both copies, fast`, () => {
    // Every word at t = 0 on both channels: identical text, no usable timing.
    const text = Array.from({ length: 4_000 }, (_, i) => SENTENCES[i % SENTENCES.length]).join(" ");
    const collapse = (channel: number) => chunk(channel, 0, 0, text).map((w) => ({ ...w, start: 0, end: 0 }));
    const words = recording(collapse(SYS), collapse(MIC));
    expect(words.length).toBeGreaterThan(40_000);

    const started = performance.now();
    const echo = findMicEcho(words);
    const elapsed = performance.now() - started;

    expect(echo.size).toBe(0);
    expect(elapsed).toBeLessThan(1_000);
  });
});
