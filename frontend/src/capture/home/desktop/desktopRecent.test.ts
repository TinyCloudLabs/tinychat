import { describe, expect, test } from "bun:test";

import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import type { LibraryItem } from "../../library/LibraryRow";
import { FINALIZATION_PENDING } from "../../recorder/recorderCopy";
import type { RecorderCaptureIssue } from "../../recorder/recorderReducer";
import { issueSheetCopy, type CaptureIssues, type HomeIssue } from "../captureIssues";
import { HOME_COPY } from "../homeCopy";
import { onThisMac } from "./desktopCopy";
import {
  desktopIssueMeta,
  desktopRecent,
  issueNeedsAttention,
  matchesRecentFilter,
  onMacNote,
  onMacTitle,
} from "./desktopRecent";

const item = (id: string, source: string, patch: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  source,
  sourceId: `src-${id}`,
  title: id,
  startedAt: "2026-10-09T08:00:00.000Z",
  durationSecs: 60,
  ...patch,
});
const note = (id: string) => item(id, "exo-voice-note");
const meeting = (id: string) => item(id, "fireflies");
const upload = (id: string) => item(id, UPLOAD_MEETING_SOURCE);
const LIBRARY = [note("n1"), meeting("m1"), upload("u1"), note("n2"), meeting("m2")];
const ids = (rows: { item: LibraryItem }[]) => rows.map((row) => row.item.id);

describe("the filter chips", () => {
  test("All shows everything, in order, uploads included", () => {
    expect(ids(desktopRecent(LIBRARY, {}, "all").items)).toEqual(["n1", "m1", "u1", "n2", "m2"]);
  });

  test("Notes are voice notes only; Meetings are meetings only, so uploads are in All only", () => {
    expect(ids(desktopRecent(LIBRARY, {}, "note").items)).toEqual(["n1", "n2"]);
    expect(ids(desktopRecent(LIBRARY, {}, "meeting").items)).toEqual(["m1", "m2"]);
    expect(matchesRecentFilter(UPLOAD_MEETING_SOURCE, "note")).toBe(false);
    expect(matchesRecentFilter(UPLOAD_MEETING_SOURCE, "meeting")).toBe(false);
  });

  test("the limit applies after the filter", () => {
    const many = Array.from({ length: 30 }, (_, i) => (i % 2 ? meeting(`m${i}`) : note(`n${i}`)));
    expect(desktopRecent(many, {}, "note", 5).items).toHaveLength(5);
    expect(desktopRecent(many, {}, "all").items).toHaveLength(20);
  });
});

describe("capture issues in Recent", () => {
  const partial: RecorderCaptureIssue = { kind: "partial_audio", missingMs: 4000 };
  const failed: RecorderCaptureIssue = { kind: "recoveryFailed", detail: "ENOSPC" };

  test("a recording with an issue and no Library row yet comes first, as a voice note", () => {
    const { attention } = desktopRecent(LIBRARY, { a: failed, b: partial }, "all");
    expect(attention).toEqual([
      { type: "partial", id: "b" },
      { type: "issue", id: "a", issue: failed },
    ]);
    expect(desktopRecent(LIBRARY, { a: failed }, "note").attention).toHaveLength(1);
    expect(desktopRecent(LIBRARY, { a: failed }, "meeting").attention).toHaveLength(0);
  });

  test("an issue row is never cut to make room", () => {
    const many = Array.from({ length: 30 }, (_, i) => note(`n${i}`));
    const out = desktopRecent(many, { a: failed }, "all");
    expect(out.attention).toHaveLength(1);
    expect(out.items).toHaveLength(19);
  });

  test("a Library voice note with partial audio keeps its row and carries the id for Dismiss", () => {
    const { attention, items } = desktopRecent(LIBRARY, { "src-n2": partial }, "all");
    expect(attention).toHaveLength(0);
    expect(items.find((row) => row.item.id === "n2")?.partialId).toBe("src-n2");
    expect(items.find((row) => row.item.id === "n1")?.partialId).toBeUndefined();
  });

  test("a Library voice note with a failure carries it; its detail is never in the row's text", () => {
    const { items } = desktopRecent(LIBRARY, { "src-n1": failed }, "all");
    expect(items[0]?.issue).toEqual(failed);
    expect(desktopIssueMeta(failed)).toBe("Couldn't recover this recording");
    expect(desktopIssueMeta(failed)).not.toContain("ENOSPC");
  });

  test("only a timed-out save resolves itself", () => {
    expect(issueNeedsAttention({ kind: "finalization_timed_out" })).toBe(false);
    expect(issueNeedsAttention(failed)).toBe(true);
    expect(issueNeedsAttention({ kind: "write_failed", detail: "x" })).toBe(true);
  });
});

describe("a recording native parked", () => {
  const parked: CaptureIssues = { p: { kind: "quarantined" } };

  test("is an issue row under All and Notes, with its audio kept", () => {
    expect(desktopRecent(LIBRARY, parked, "all").attention).toEqual([
      { type: "issue", id: "p", issue: { kind: "quarantined" } },
    ]);
    expect(desktopRecent(LIBRARY, parked, "meeting").attention).toHaveLength(0);
    expect(desktopIssueMeta({ kind: "quarantined" })).toBe("Couldn't recover this recording · audio kept");
    expect(issueNeedsAttention({ kind: "quarantined" })).toBe(true);
  });

  test("the card says so", () => {
    expect(onMacNote(parked, null)).toBe("Not in your space yet · Couldn't recover · audio kept");
  });
});

describe("the failed-recording sheet's copy on the desktop", () => {
  const kinds: HomeIssue[] = [
    { kind: "recoveryFailed", detail: "x" },
    { kind: "quarantined" },
    { kind: "quarantined", unplayable: true },
    { kind: "write_failed", detail: "x" },
  ];

  test("names this Mac, never this phone", () => {
    const lines = [
      ...kinds.flatMap((issue) => {
        const copy = issueSheetCopy(issue)!;
        return [copy.title, copy.body];
      }),
      HOME_COPY.tryAgainFailed,
      HOME_COPY.deleteFailed,
      HOME_COPY.deleteConfirm.title,
      HOME_COPY.deleteConfirm.body,
    ];
    for (const line of lines) expect(onThisMac(line)).not.toContain("phone");
    expect(onThisMac(HOME_COPY.deleteConfirm.body)).toBe(
      "The audio will be deleted from this Mac. This can't be undone.",
    );
  });
});

describe("the on-this-Mac card", () => {
  test("a count, singular or plural, saying Mac", () => {
    expect(onMacTitle(1)).toBe("1 voice note on this Mac");
    expect(onMacTitle(3)).toBe("3 voice notes on this Mac");
  });

  test("its note follows the worst thing that happened", () => {
    expect(onMacNote({}, null)).toBe("Not in your space yet");
    expect(onMacNote({ a: { kind: "finalization_timed_out" } }, null)).toBe(
      "Kept on this Mac. Exo will finish it automatically.",
    );
    expect(onMacNote({}, FINALIZATION_PENDING)).toBe("Kept on this Mac. Exo will finish it automatically.");
    expect(
      onMacNote({ a: { kind: "finalization_timed_out" }, b: { kind: "recoveryFailed", detail: "x" } }, FINALIZATION_PENDING),
    ).toBe("Not in your space yet · Exo will retry when it next opens");
    expect(onMacNote({ a: { kind: "write_failed", detail: "x" } }, null)).toBe(
      "Not in your space yet · Couldn't save all of this recording",
    );
    expect(onMacNote({}, "Couldn't reach your space")).toBe("Couldn't reach your space");
  });
});
