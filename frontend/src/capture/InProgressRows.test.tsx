// In progress on Capture: the recorder's rows. Notes still only on this phone
// are told with Save now (busy while a save runs), and a recording stopped at
// its length limit says so (TC-517). Nothing in progress, nothing shown.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InProgressRowsView, type VoiceInProgress } from "./InProgressRows";

const noop = () => {};

function render(voice?: Partial<VoiceInProgress>): string {
  return renderToStaticMarkup(
    <InProgressRowsView
      upload={null}
      paused={null}
      meetings={[]}
      busyId={null}
      voice={voice ? { listing: { state: "ok", count: 0 }, saving: false, lastError: null, limitNotice: null, onSaveNow: noop, ...voice } : undefined}
      onOpenUpload={noop}
      onContinue={noop}
      onOpenMeeting={noop}
      onEnd={noop}
    />,
  );
}

describe("In progress: voice notes", () => {
  test("nothing on the phone (or not asked yet) and no limit: no section", () => {
    expect(render()).toBe("");
    expect(render({})).toBe("");
    expect(render({ listing: { state: "unknown" } })).toBe("");
  });

  test("a listing that failed is never \"nothing pending\": a recovery row with Try again", () => {
    const html = render({ listing: { state: "error", message: "Could not check this phone for unsaved notes: no bridge" } });
    expect(html).toContain('data-testid="voice-note-list-failed"');
    expect(html).toContain("Couldn&#x27;t check this phone for unsaved notes");
    expect(html).toContain("no bridge");
    expect(html).toContain('data-testid="voice-note-list-retry"');
    expect(html).toContain(">Try again</button>");
  });

  test("notes left on the phone are told, with Save now", () => {
    const one = render({ listing: { state: "ok", count: 1 } });
    expect(one).toContain('data-testid="voice-note-pending"');
    expect(one).toContain("1 voice note on this phone");
    expect(one).toContain("Not in your space yet");
    expect(one).toContain('data-testid="voice-note-retry"');
    expect(render({ listing: { state: "ok", count: 3 } })).toContain("3 voice notes on this phone");
  });

  test("Save now is disabled while a save runs, and a failure is told", () => {
    expect(render({ listing: { state: "ok", count: 1 }, saving: true })).toMatch(/<button[^>]*disabled=""[^>]*data-testid="voice-note-retry"/);
    expect(render({ listing: { state: "ok", count: 1 }, lastError: "The network connection was lost." })).toContain("The network connection was lost.");
  });

  test("a note stopped at the limit says so, in its own element (the smoke script reads it)", () => {
    const html = render({ limitNotice: "Stopped at the 60-minute limit." });
    expect(html).toContain('data-testid="voice-note-limit">Stopped at the 60-minute limit.</span>');
  });
});
