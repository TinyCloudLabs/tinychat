import { describe, expect, test } from "bun:test";

import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import type { LibraryItem } from "../../library/LibraryRow";
import { FINALIZATION_PENDING } from "../../recorder/recorderCopy";
import type { RecorderCaptureIssue } from "../../recorder/recorderReducer";
import { issueSheetCopy, type CaptureIssues, type HomeIssue } from "../captureIssues";
import { HOME_COPY } from "../homeCopy";
import { forPlace, homePlace } from "./desktopCopy";
import {
  desktopIssueMeta,
  desktopRecent,
  issueNeedsAttention,
  matchesRecentFilter,
  pendingNote,
  pendingTitle,
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
    expect(desktopIssueMeta({ kind: "quarantined" }, "mac")).toBe("Couldn't recover this recording · audio kept");
    expect(issueNeedsAttention({ kind: "quarantined" })).toBe(true);
  });

  test("the card says so", () => {
    expect(pendingNote(parked, null, "mac")).toBe("Not in your space yet · Couldn't recover · audio kept");
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
    for (const line of lines) expect(forPlace("mac")(line)).not.toContain("phone");
    expect(forPlace("mac")(HOME_COPY.deleteConfirm.body)).toBe(
      "The audio will be deleted from this Mac. This can't be undone.",
    );
  });
});

describe("the unsaved-voice-notes card", () => {
  test("a count, singular or plural, saying Mac", () => {
    expect(pendingTitle(1, "mac")).toBe("1 voice note on this Mac");
    expect(pendingTitle(3, "mac")).toBe("3 voice notes on this Mac");
  });

  test("its note follows the worst thing that happened", () => {
    expect(pendingNote({}, null, "mac")).toBe("Not in your space yet");
    expect(pendingNote({ a: { kind: "finalization_timed_out" } }, null, "mac")).toBe(
      "Kept on this Mac. Exo will finish it automatically.",
    );
    expect(pendingNote({}, FINALIZATION_PENDING, "mac")).toBe("Kept on this Mac. Exo will finish it automatically.");
    expect(
      pendingNote({ a: { kind: "finalization_timed_out" }, b: { kind: "recoveryFailed", detail: "x" } }, FINALIZATION_PENDING, "mac"),
    ).toBe("Not in your space yet · Exo will retry when it next opens");
    expect(pendingNote({ a: { kind: "write_failed", detail: "x" } }, null, "mac")).toBe(
      "Not in your space yet · Couldn't save all of this recording",
    );
    expect(pendingNote({}, "Couldn't reach your space", "mac")).toBe("Couldn't reach your space");
  });
});

describe("the card names where the recordings are kept", () => {
  test("a Mac, a browser or a phone or tablet app", () => {
    expect(homePlace("tauri")).toBe("mac");
    expect(homePlace("web")).toBe("browser");
    expect(homePlace("ios")).toBe("device");
    expect(homePlace("android")).toBe("device");
    expect(pendingTitle(2, "browser")).toBe("2 voice notes in this browser");
    expect(pendingTitle(1, "device")).toBe("1 voice note on this device");
    expect(pendingNote({ a: { kind: "finalization_timed_out" } }, null, "browser")).toBe(
      "Kept in this browser. Exo will finish it automatically.",
    );
    expect(pendingNote({}, FINALIZATION_PENDING, "device")).toBe(
      "Kept on this device. Exo will finish it automatically.",
    );
    expect(desktopIssueMeta({ kind: "finalization_timed_out" }, "device")).toBe("Saving… · kept on this device");
  });

  test("the failed-recording sheet's copy follows, never saying Mac or phone off the Mac", () => {
    const body = HOME_COPY.deleteConfirm.body;
    expect(forPlace("device")(body)).toBe("The audio will be deleted from this device. This can't be undone.");
    expect(forPlace("browser")(HOME_COPY.timedOutSheet.body)).toBe(
      "Kept in this browser. Exo will finish it automatically.",
    );
    for (const line of [body, HOME_COPY.partialAudioSheet.body, HOME_COPY.tryAgainFailed])
      for (const place of ["device", "browser"] as const) {
        expect(forPlace(place)(line)).not.toContain("Mac");
        expect(forPlace(place)(line)).not.toContain("phone");
      }
  });
});
