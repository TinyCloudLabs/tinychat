// Library rows on a phone (TC-522): the title must stay readable at 412 px,
// not be truncated beside the source chip and date.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { MeetingRowLabel } from "./MeetingsPage";

function classesOf(markup: string, text: string): string[] {
  // The class attribute of the innermost element whose text starts with `text`.
  const at = markup.indexOf(`>${text}`);
  expect(at).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", at);
  const tag = markup.slice(open, at);
  return /class="([^"]*)"/.exec(tag)?.[1].split(" ") ?? [];
}

describe("MeetingRowLabel", () => {
  const voiceNote = {
    title: "Voice note · Sep 29, 1:40 PM",
    source: VOICE_NOTE_SOURCE,
    startedAt: "2026-09-29T13:40:00.000Z",
  };

  test("phones: the title wraps on its own line; it only truncates from sm up", () => {
    const markup = renderToStaticMarkup(<MeetingRowLabel meeting={voiceNote} />);
    const title = classesOf(markup, voiceNote.title);
    expect(title).not.toContain("truncate");
    expect(title).toContain("break-words");
    expect(title).toContain("sm:truncate");

    // The label stacks (title over chip and date) below sm and is one row above.
    const wrapper = /^<span class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
    expect(wrapper).toContain("flex-col");
    expect(wrapper).toContain("sm:flex-row");
    expect(wrapper).toContain("min-w-0");
  });

  test("keeps the source chip and the date on the row", () => {
    const markup = renderToStaticMarkup(<MeetingRowLabel meeting={voiceNote} />);
    expect(markup).toContain(">Voice note</span>");
    expect(markup).toContain(new Date(voiceNote.startedAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }));
  });

  test("an untitled meeting without a date still renders its fallback and chip", () => {
    const markup = renderToStaticMarkup(
      <MeetingRowLabel meeting={{ title: null, source: VOICE_NOTE_SOURCE, startedAt: null }} />,
    );
    expect(markup).toContain("Untitled meeting");
    expect(markup).toContain(">Voice note</span>");
  });
});
