import { beforeEach, describe, expect, test } from "bun:test";
import { ambiguousCalendarLink, linkedCalendarLink, refreshedCalendarLink, unlinkedCalendarLink } from "@tinyboilerplate/core";

import { clearAllCalendarLinks, writeRowCalendarLink, writeRowMeetingCode } from "./calendarLinkRows";
import { at, calendarLinkSpace, timed, type CalendarLinkSpace } from "./calendarLinkSpace.fixture";

const STANDUP = timed("standup", at(10), at(11));
const REVIEW = timed("review", at(10.5), at(11.5));
const BY_TIME = { method: "time_overlap", confidence: "medium", overlap: 1 } as const;
const NOW = "2026-11-27T12:00:00.000Z";

let space: CalendarLinkSpace;
beforeEach(() => { space = calendarLinkSpace(); });

describe("an automatic link", () => {
  test("is stored on a row without one, and moves updated_at without touching the rest of the row", async () => {
    const note = await space.add("exo-voice-note", "n1", at(10), 1800, { speaker_names: { "Speaker 1": "Alice" } });
    const before = space.stored(note.id);

    expect(await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(STANDUP, BY_TIME, NOW), "automatic")).toBe(true);

    expect(space.link(note.id)).toMatchObject({ event_id: "standup", match: { method: "time_overlap", confidence: "medium" } });
    expect(space.meta(note.id).speaker_names).toEqual({ "Speaker 1": "Alice" });
    expect(space.stored(note.id).title).toBe(before.title);
    expect(space.stored(note.id).updated_at > before.updated_at).toBe(true);
  });

  test("is stored on a row that has no metadata yet", async () => {
    const note = await space.add("fireflies", "f1", at(10), 1800, null);
    expect(await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(STANDUP, BY_TIME, NOW), "automatic")).toBe(true);
    expect(space.link(note.id)?.event_id).toBe("standup");
  });

  test("never replaces a link, a pending pick or the user's none", async () => {
    const linked = await space.add("exo-voice-note", "linked", at(10), 1800);
    const waiting = await space.add("exo-voice-note", "waiting", at(10), 1800);
    const none = await space.add("exo-voice-note", "none", at(10), 1800);
    await writeRowCalendarLink(space.tcw, linked.id, linkedCalendarLink(STANDUP, "user", NOW), "user");
    await writeRowCalendarLink(space.tcw, waiting.id, ambiguousCalendarLink([STANDUP, REVIEW]), "user");
    await writeRowCalendarLink(space.tcw, none.id, unlinkedCalendarLink(NOW), "user");

    for (const note of [linked, waiting, none]) {
      const stored = space.link(note.id);
      expect(await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(REVIEW, BY_TIME, NOW), "automatic")).toBe(false);
      expect(space.link(note.id)).toEqual(stored!);
    }
  });
});

describe("the user's write", () => {
  test("replaces whatever is stored", async () => {
    const note = await space.add("exo-voice-note", "n1", at(10), 1800);
    await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(STANDUP, BY_TIME, NOW), "automatic");

    expect(await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(REVIEW, "user", NOW), "user")).toBe(true);
    expect(space.link(note.id)).toMatchObject({ event_id: "review", match: { method: "user", confidence: "user" } });

    expect(await writeRowCalendarLink(space.tcw, note.id, unlinkedCalendarLink(NOW), "user")).toBe(true);
    expect(space.link(note.id)).toEqual(unlinkedCalendarLink(NOW));
  });
});

describe("a refreshed link", () => {
  test("is stored only while the row is still linked to the event that was read again", async () => {
    const note = await space.add("exo-voice-note", "n1", at(10), 1800);
    const link = linkedCalendarLink(STANDUP, BY_TIME, NOW);
    await writeRowCalendarLink(space.tcw, note.id, link, "automatic");
    const renamed = refreshedCalendarLink(link, { ...STANDUP, summary: "Standup, renamed" });

    expect(await writeRowCalendarLink(space.tcw, note.id, renamed, { refreshOf: "standup" })).toBe(true);
    expect(space.link(note.id)?.title).toBe("Standup, renamed");

    // The user picked another event while the old one was being read.
    await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(REVIEW, "user", NOW), "user");
    expect(await writeRowCalendarLink(space.tcw, note.id, renamed, { refreshOf: "standup" })).toBe(false);
    expect(space.link(note.id)?.event_id).toBe("review");

    await writeRowCalendarLink(space.tcw, note.id, unlinkedCalendarLink(NOW), "user");
    expect(await writeRowCalendarLink(space.tcw, note.id, renamed, { refreshOf: "standup" })).toBe(false);
    expect(space.link(note.id)?.event_id).toBeUndefined();
  });
});

describe("removing calendar details", () => {
  test("takes the link off every row that has one and says how many", async () => {
    const linked = await space.add("exo-voice-note", "linked", at(10), 1800, { speaker_names: { "Speaker 1": "Alice" } });
    const none = await space.add("google-meet", "none", at(10), 1800, { space: "spaces/abc" });
    const plain = await space.add("fireflies", "plain", at(10), 1800, { keep: true });
    await writeRowCalendarLink(space.tcw, linked.id, linkedCalendarLink(STANDUP, BY_TIME, NOW), "automatic");
    await writeRowCalendarLink(space.tcw, none.id, unlinkedCalendarLink(NOW), "user");
    const untouched = space.stored(plain.id);

    expect(await clearAllCalendarLinks(space.tcw)).toBe(2);

    expect(space.meta(linked.id)).toEqual({ speaker_names: { "Speaker 1": "Alice" } });
    expect(space.meta(none.id)).toEqual({ space: "spaces/abc" });
    expect(space.stored(plain.id)).toEqual(untouched);
    expect(await clearAllCalendarLinks(space.tcw)).toBe(0);
  });
});

describe("a Google Meet import's meeting code", () => {
  test("is kept on the import's row, once, and on no other kind of row", async () => {
    const imported = await space.add("google-meet", "rec-1", at(10), 1800, { space: "spaces/abc" });
    const voice = await space.add("exo-voice-note", "n1", at(10), 1800);

    expect(await writeRowMeetingCode(space.tcw, imported.id, "abc-defg-hij")).toBe(true);
    expect(space.meta(imported.id)).toEqual({ space: "spaces/abc", meeting_code: "abc-defg-hij" });
    expect(await writeRowMeetingCode(space.tcw, imported.id, "abc-defg-hij")).toBe(false);
    expect(await writeRowMeetingCode(space.tcw, voice.id, "abc-defg-hij")).toBe(false);
    expect(space.meta(voice.id)).toEqual({});
  });
});
