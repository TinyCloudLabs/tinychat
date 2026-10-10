// What the recorder's capture issues become on Capture home (TC-871).
import { describe, expect, spyOn, test } from "bun:test";

import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import type { LibraryItem } from "../library/LibraryRow";
import { FINALIZATION_PENDING } from "../recorder/recorderCopy";
import {
  type HomeIssue,
  dismissNotice,
  issueIsFailure,
  issueIsInformational,
  partialAudioMissingLine,
  issueIsRecoverable,
  recoveryFailedKey,
  withQuarantine,
  cardNote,
  issueForItem,
  issueCanRetry,
  issueHasSheet,
  issueMeta,
  issueSheetCopy,
  orphanIssues,
  sheetIssue,
  recentEntries,
} from "./captureIssues";
import { HOME_COPY } from "./homeCopy";

const timedOut: RecorderCaptureIssue = { kind: "finalization_timed_out" };
const failed: RecorderCaptureIssue = {
  kind: "recoveryFailed",
  detail: "ENOSPC /var/mobile/secret.m4a",
};
const writeFailed: RecorderCaptureIssue = {
  kind: "write_failed",
  detail: "EIO",
};
const partial: RecorderCaptureIssue = { kind: "partial_audio", missingMs: 3000,
  spans: [{ startMs: 2000, endMs: 5000, reason: "writer_stalled" }] };

const note = (i: number): LibraryItem => ({
  id: `row-${i}`,
  source: "exo-voice-note",
  sourceId: `rec-${i}`,
  title: `Voice note · ${i}`,
  startedAt: null,
  durationSecs: 10,
});

describe("issue copy", () => {
  test("each state has its own line, and `detail` is never in any of it", () => {
    expect(issueMeta(timedOut)).toBe("Saving… · kept on this phone");
    expect(issueMeta(failed)).toBe("Couldn't recover this recording");
    expect(issueMeta(writeFailed)).toBe("Couldn't save all of this recording");
    const everything = JSON.stringify([
      issueMeta(failed),
      issueMeta(writeFailed),
      issueSheetCopy(failed),
      issueSheetCopy(writeFailed),
    ]);
    expect(everything).not.toContain("ENOSPC");
    expect(everything).not.toContain("EIO");
  });

  test("the recovery sheet says what happens next and offers no action but Close", () => {
    expect(issueSheetCopy(failed)).toEqual({
      title: "Couldn't recover this recording",
      body: "Exo couldn't finish saving this recording. It will try again when it next opens.",
    });
    expect(HOME_COPY.close).toBe("Close");
    // Try again and Delete wait for TC-868 (native retry and discard).
    expect(
      JSON.stringify([
        HOME_COPY.recoveryFailedSheet,
        HOME_COPY.writeFailedSheet,
      ]),
    ).not.toMatch(/Try again|Delete/);
  });

  test("a timed-out recording's sheet explains it is kept on this phone and offers no action", () => {
    const copy = issueSheetCopy(timedOut);
    expect(copy.title).toBe("Saving this recording");
    expect(copy.body).toBe(
      "Kept on this phone. Exo will finish it automatically.",
    );
    expect(JSON.stringify(copy)).not.toMatch(/Try again|Delete/);
  });

  test("a Library row for a timed-out recording still opens its note; the failures open a sheet", () => {
    expect(issueHasSheet(timedOut)).toBe(false);
    expect(issueHasSheet(failed)).toBe(true);
    expect(issueHasSheet(writeFailed)).toBe(true);
  });

  test("partial audio is informational: a saved recording's row marker and sheet, never a failure", () => {
    expect(issueIsInformational(partial)).toBe(true);
    expect(issueIsFailure(partial)).toBe(false);
    expect(issueIsFailure(timedOut)).toBe(false);
    expect(issueIsFailure(failed)).toBe(true);
    expect(issueMeta(partial)).toBe("Saved — part of this recording couldn't be written");
    expect(issueHasSheet(partial)).toBe(false); // the row still opens the note; Details opens the sheet
    expect(sheetIssue("rec-1", { "rec-1": partial }, true)).toBe(partial);
    expect(sheetIssue("rec-1", { "rec-1": partial }, false)).toBeNull();
    expect(issueForItem(note(1), { "rec-1": partial })).toBe(partial);
    expect(orphanIssues([], { "rec-1": partial })).toEqual([]);
    expect(recentEntries([note(1)], { "rec-1": partial }, 5)).toEqual([
      { type: "item", item: note(1), issue: partial },
    ]);
    expect(cardNote({ "rec-1": partial }, null)).toBe(HOME_COPY.notInSpace);
  });

  test("the partial-audio sheet: a title, one honest line, and what is missing only when known", () => {
    expect(issueSheetCopy(partial)).toEqual({
      title: "Part of this recording couldn't be written",
      body: "The recording was saved, but this phone couldn't write all of the audio. The part that couldn't be written is missing.",
    });
    expect(partialAudioMissingLine({ kind: "partial_audio", missingMs: 12_000 })).toBe("About 0:12 is missing");
    expect(partialAudioMissingLine({ kind: "partial_audio", missingMs: 72_400 })).toBe("About 1:12 is missing");
    expect(partialAudioMissingLine({ kind: "partial_audio", missingMs: 400 })).toBe("Less than a second is missing");
    expect(partialAudioMissingLine({ kind: "partial_audio" })).toBeNull();
    expect(partialAudioMissingLine({ kind: "partial_audio", missingMs: 0 })).toBeNull();
    expect(partialAudioMissingLine({ kind: "partial_audio", missingMs: Number.NaN })).toBeNull();
    expect(partialAudioMissingLine(failed)).toBeNull();
    // Spans are not rendered in this slice.
    expect(JSON.stringify([issueSheetCopy(partial), partialAudioMissingLine(partial)])).not.toMatch(/writer_stalled|2000|5000/);
  });

  test("a failure outranks a partial-audio notice for the same recording", () => {
    const merged = withQuarantine({ a: partial, b: partial }, [{ id: "a", reason: "corrupt_journal" }], new Set());
    expect(merged.a).toEqual({ kind: "quarantined" });
    expect(merged.b).toBe(partial);
    expect(cardNote({ a: partial, b: failed }, null)).toBe("Not in your space yet · Exo will retry when it next opens");
  });

  test("Dismiss: gone on success; otherwise the failure is logged and a line is returned", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(dismissNotice("rec-1", () => true)).toBeNull();
      expect(error).not.toHaveBeenCalled();
      expect(dismissNotice("rec-1", () => false)).toBe(HOME_COPY.dismissFailed);
      expect(error).toHaveBeenCalledTimes(1);
      expect(dismissNotice("rec-1", () => { throw new Error("boom"); })).toBe(HOME_COPY.dismissFailed);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  test("an open sheet follows the provider's current issue: it changes with it and is gone once it clears", () => {
    expect(sheetIssue("rec-1", { "rec-1": failed }, true)).toBe(failed);
    expect(sheetIssue("rec-1", { "rec-1": writeFailed }, true)).toBe(
      writeFailed,
    );
    expect(sheetIssue("rec-1", {}, true)).toBeNull();
    expect(sheetIssue("rec-1", { "rec-2": failed }, true)).toBeNull();
    expect(sheetIssue("rec-1", { "rec-1": failed }, false)).toBeNull();
    expect(sheetIssue(null, { "rec-1": failed }, true)).toBeNull();
  });
});

describe("matching rows", () => {
  test("a Library voice note carries the issue of its recording id", () => {
    expect(issueForItem(note(1), { "rec-1": failed })).toBe(failed);
    expect(issueForItem(note(2), { "rec-1": failed })).toBeUndefined();
    expect(
      issueForItem({ ...note(1), source: "fireflies" }, { "rec-1": failed }),
    ).toBeUndefined();
  });

  test("Recent: a recording not in the space leads, newest issue first, then the Library fills to five", () => {
    const items = [1, 2, 3, 4, 5, 6].map(note);
    const entries = recentEntries(
      items,
      { "rec-old": timedOut, "rec-new": failed },
      5,
    );
    expect(
      entries.map((e) => (e.type === "issue" ? `issue:${e.id}` : e.item.id)),
    ).toEqual(["issue:rec-new", "issue:rec-old", "row-1", "row-2", "row-3"]);
  });

  test("orphanIssues: only recordings with no Library row, newest issue first, shared by Recent and the Library", () => {
    const items = [note(1), note(2)];
    const issues = {
      "rec-1": writeFailed,
      "rec-old": timedOut,
      "rec-new": failed,
    };
    expect(orphanIssues(items, issues).map((o) => o.id)).toEqual([
      "rec-new",
      "rec-old",
    ]);
    const recent = recentEntries(items, issues, 5).flatMap((e) =>
      e.type === "issue" ? [e.id] : [],
    );
    expect(recent).toEqual(orphanIssues(items, issues).map((o) => o.id));
  });

  test("a recording already in the Library is decorated, not repeated", () => {
    const entries = recentEntries(
      [note(1), note(2)],
      { "rec-2": writeFailed },
      5,
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ type: "item", issue: writeFailed });
  });

  test("an issue row is never cut to make room", () => {
    const issues = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`r${i}`, timedOut]),
    );
    expect(recentEntries([note(1)], issues, 5)).toHaveLength(6);
  });
});

describe("the on-this-phone card's note", () => {
  const pending = "Kept on this phone. Exo will finish it automatically.";
  const retry = "Not in your space yet · Exo will retry when it next opens";
  const parkedNote = "Not in your space yet · Couldn't recover · audio kept";
  const kept = "Not in your space yet · Couldn't save all of this recording";
  const cases: [string, Record<string, HomeIssue>, string | null, string][] = [
    ["nothing wrong keeps the plain line", {}, null, "Not in your space yet"],
    ["a timed-out recording says Exo will finish it", { a: timedOut }, null, pending],
    ["recoveryFailed overrides it: never both", { a: timedOut, b: failed }, null, retry],
    ["recoveryFailed alone", { b: failed }, null, retry],
    ["quarantined promises no retry", { b: { kind: "quarantined" } }, null, parkedNote],
    ["unplayable quarantined promises no retry", { b: { kind: "quarantined", unplayable: true } }, null, parkedNote],
    ["recoveryFailed still wins over quarantined", { a: failed, b: { kind: "quarantined" } }, null, retry],
    ["write_failed has its own line", { b: writeFailed }, null, kept],
    ["write_failed overrides a timed-out one", { a: timedOut, b: writeFailed }, null, kept],
    ["a save error is what the card already said", { a: failed }, "No connection", "No connection"],
    ["a save error shows with no issue too", {}, "No connection", "No connection"],
    ["the finishing promise as lastError yields to recoveryFailed", { a: failed }, FINALIZATION_PENDING, retry],
    ["the finishing promise as lastError yields to write_failed", { a: writeFailed }, FINALIZATION_PENDING, kept],
    ["the finishing promise as lastError stays with nothing failed", { a: timedOut }, FINALIZATION_PENDING, pending],
    ["the finishing promise as lastError stays with no issue", {}, FINALIZATION_PENDING, pending],
    ["partial_audio is not an error: it keeps the plain line", { a: partial }, null, "Not in your space yet"],
    ["partial_audio does not suppress the finishing promise", { a: partial }, FINALIZATION_PENDING, pending],
    ["partial_audio does not trigger it", { a: partial, b: timedOut }, null, pending],
    ["partial_audio does not outrank a real failure", { a: partial, b: failed }, FINALIZATION_PENDING, retry],
  ];
  for (const [name, issues, lastError, expected] of cases) {
    test(name, () => {
      const note = cardNote(issues, lastError);
      expect(note).toBe(expected);
      if (
        Object.values(issues).some((issue) => issue.kind !== "finalization_timed_out" && issue.kind !== "partial_audio") &&
        lastError === FINALIZATION_PENDING
      )
        expect(note).not.toContain("automatically");
    });
  }
});

describe("quarantined recordings", () => {
  const parked: HomeIssue = { kind: "quarantined" };
  const q = (id: string, reason = "corrupt_journal") => ({ id, reason });

  test("its row and sheet say the audio is kept, and open the sheet", () => {
    expect(issueMeta(parked)).toBe("Couldn't recover this recording · audio kept");
    expect(issueHasSheet(parked)).toBe(true);
    expect(issueSheetCopy(parked).title).toBe("Couldn't recover this recording");
    expect(issueIsRecoverable(parked)).toBe(true);
  });

  test("Try again and Delete apply to recoveryFailed and quarantined only", () => {
    expect(issueIsRecoverable(failed)).toBe(true);
    expect(issueIsRecoverable(writeFailed)).toBe(false);
    expect(issueIsRecoverable(timedOut)).toBe(false);
  });

  test("a quarantined session replaces recoveryFailed and adds a row of its own", () => {
    const merged = withQuarantine({ a: failed, b: writeFailed }, [q("a"), q("c"), q("b")], new Set());
    expect(merged.a).toEqual({ kind: "quarantined" });
    expect(merged.c).toEqual({ kind: "quarantined" });
    expect(merged.b).toEqual(writeFailed);
  });

  test("unplayable audio is Delete only, with an honest sheet", () => {
    const merged = withQuarantine(
      {},
      [q("u", "unplayable"), q("n", "no_audio_track"), q("v")],
      new Set(),
    );
    expect(merged.n).toEqual({ kind: "quarantined", unplayable: true });
    expect(issueCanRetry(merged.n!)).toBe(false);
    expect(merged.u).toEqual({ kind: "quarantined", unplayable: true });
    expect(issueCanRetry(merged.u!)).toBe(false);
    expect(issueCanRetry(merged.v!)).toBe(true);
    expect(issueCanRetry(failed)).toBe(true);
    expect(issueIsRecoverable(merged.u!)).toBe(true);
    expect(issueSheetCopy(merged.u!).body).toBe("This recording can't be recovered. You can delete it.");
    expect(issueMeta(merged.u!)).toBe("Couldn't recover this recording · audio kept");
  });

  test("a deleted recording drops out of both", () => {
    const merged = withQuarantine({ a: failed }, [q("a"), q("c")], new Set(["a", "c"]));
    expect(merged).toEqual({});
  });

  test("orphan quarantined sessions get a Recent row", () => {
    const merged = withQuarantine({}, [q("q")], new Set());
    expect(orphanIssues([], merged)).toEqual([{ id: "q", issue: { kind: "quarantined" } }]);
  });

  test("the refresh key changes when a recoveryFailed issue appears or clears, not for other issues", () => {
    const none = recoveryFailedKey({});
    const one = recoveryFailedKey({ a: failed });
    expect(one).not.toBe(none);
    expect(recoveryFailedKey({ a: failed, b: failed })).not.toBe(one);
    expect(recoveryFailedKey({ a: failed, b: writeFailed })).toBe(one);
    expect(recoveryFailedKey({ b: timedOut })).toBe(none);
  });
});
