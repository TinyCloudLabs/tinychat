// What the recorder's capture issues become on Capture home (TC-871).
import { describe, expect, test } from "bun:test";

import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import type { LibraryItem } from "../library/LibraryRow";
import {
  cardNote,
  issueForItem,
  issueHasSheet,
  issueMeta,
  issueSheetCopy,
  orphanIssues,
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

  test("a timed-out recording has no sheet: it resolves itself", () => {
    expect(issueHasSheet(timedOut)).toBe(false);
    expect(issueSheetCopy(timedOut)).toBeNull();
    expect(issueHasSheet(failed)).toBe(true);
    expect(issueHasSheet(writeFailed)).toBe(true);
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
  test("nothing wrong keeps the plain line", () => {
    expect(cardNote({}, null)).toBe("Not in your space yet");
  });

  test("a timed-out recording says Exo will finish it", () => {
    expect(cardNote({ a: timedOut }, null)).toBe(
      "Not in your space yet · Exo will finish it automatically",
    );
  });

  test("recoveryFailed overrides it: never both", () => {
    const note = cardNote({ a: timedOut, b: failed }, null);
    expect(note).toBe(
      "Not in your space yet · Exo will retry when it next opens",
    );
    expect(note).not.toContain("automatically");
    expect(cardNote({ b: failed }, null)).not.toContain("automatically");
  });

  test("a save error is what the card already said", () => {
    expect(cardNote({ a: failed }, "No connection")).toBe("No connection");
  });
});
