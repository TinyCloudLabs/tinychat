// Capture's fixed tree (TC-761): the home, the Library and the note pane are
// all mounted and only classes move between them. The panes are rendered on
// the server (as the web app on a phone-sized screen, where there is no
// recorder); test/shell-invariants.e2e.test.ts resizes a live one across the
// size classes and counts the recorder's listeners with the fake plugin.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { screenFor } from "../shell/routes";
import { CaptureSurface } from "./CaptureSurface";
import { StaticRecorderProvider } from "./recorder/RecorderProvider";

const tcw = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
function render(path: string, active: boolean) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <StaticRecorderProvider value={{ available: false }}>
      <CaptureSurface
        tcw={tcw}
        backendUrl="http://127.0.0.1"
        sessionStore={{} as SessionStore}
        active={active}
        screen={screenFor(path)}
        meetingsSlot={<p>cohort-meetings</p>}
      />
      </StaticRecorderProvider>
    </MemoryRouter>,
  );
}

/** The class list and inner markup of the pane with this test id. */
function pane(markup: string, testId: string) {
  const at = markup.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<div", at);
  return {
    classes: /class="([^"]*)"/.exec(markup.slice(open, at))?.[1].split(" ") ?? [],
    after: markup.slice(at),
  };
}

describe("CaptureSurface", () => {
  test("on Capture: home shows, the Library and the note pane are mounted and hidden", () => {
    const markup = render("/chat/capture", true);
    expect(pane(markup, "capture-home").classes).not.toContain("hidden");
    expect(pane(markup, "capture-library").classes).toEqual(["hidden"]);
    expect(pane(markup, "capture-detail").classes).toEqual(["hidden"]);
    // Home: the title, the gear and the Library link; the Upload and Meeting actions.
    expect(markup).toContain(">Capture</span>");
    expect(markup).toContain('href="/chat/capture/library"');
    expect(markup).toContain('aria-label="Upload audio"');
    expect(markup).toContain('aria-label="Send a notetaker to a meeting"');
    // Recent waits for the list (skeleton rows), with See all.
    expect(markup).toContain('data-testid="capture-recent"');
    expect(markup).toContain(">See all</a>");
    // The Library is there, with both meeting data paths.
    expect(pane(markup, "capture-library").after).toContain('data-testid="library-list"');
    expect(markup).toContain("cohort-meetings");
  });

  test("on the Library: the Library shows with Back and Refresh, and the home stays mounted", () => {
    const markup = render("/chat/capture/library", true);
    expect(pane(markup, "capture-home").classes).toEqual(["hidden"]);
    expect(pane(markup, "capture-library").classes).not.toContain("hidden");
    const library = pane(markup, "capture-library").after;
    expect(library).toContain(">Back</button>");
    expect(library).toContain('aria-label="Refresh the Library"');
    expect(library).toContain('data-state="loading"');
    // The home (and a desktop local recording in it) is still mounted.
    expect(pane(markup, "capture-home").after).toContain('data-testid="capture-actions"');
  });

  test("on a note: the note shows with Back, over a hidden list pane that stays mounted", () => {
    const markup = render("/chat/capture/library/row-1", true);
    expect(pane(markup, "capture-list-pane").classes).toEqual(["hidden"]);
    expect(pane(markup, "capture-detail").classes).not.toContain("hidden");
    const detail = pane(markup, "capture-detail").after;
    expect(detail).toContain(">Back</button>");
    // Opened before the list has answered: it waits for it.
    expect(detail).toContain('data-testid="note-loading"');
    expect(pane(markup, "capture-home").after).toContain('data-testid="capture-actions"');
  });

  test("Record sits in the actions row; Recent, the Library and a note read through one useLibrary", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    expect(source).not.toContain("VoiceNotesListCard");
    expect(source.match(/useLibrary\(/g)).toHaveLength(1);
    expect(source).toContain("<LibraryScreen");
    expect(source).toContain("<NoteDetail");
    // One Record: the actions row's slot, between Upload and Meeting.
    expect(source.match(/<RecordButton\b/g)).toHaveLength(1);
    expect(source).toContain('record={<RecordButton variant="action" />}');
    // The recorder's notes on the phone and its limit notice are In progress rows.
    expect(source).toContain("pendingVisible ? recorder.pending.listing");
    // App and the harness hand `active` from the screen's destination.
    const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
    expect(app).toContain('active={screen.destination === "capture"}');
  });

  test("the fixed tree: one list pane (home above the Library) and one detail pane, whatever the size", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    // Each pane is written once; the size class changes only classes and attributes.
    for (const id of ["capture-list-pane", "capture-home", "capture-library", "capture-detail"]) {
      expect(source.match(new RegExp(`data-testid="${id}"`, "g"))).toHaveLength(1);
    }
    expect(source.indexOf('data-testid="capture-home"')).toBeLessThan(source.indexOf('data-testid="capture-library"'));
    expect(source.indexOf('data-testid="capture-library"')).toBeLessThan(source.indexOf('data-testid="capture-detail"'));
    expect(source.match(/meetingsSlot=\{meetingsSlot\}/g)).toHaveLength(1);
  });

  test("the desktop local recorder is mounted whatever shows, and the sheets close when the home is left", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    // Never behind `active`: unmounting the panel stops a recording without saving it.
    expect(source).toContain("{localRecorder && <LocalRecorderCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />}");
    expect(source).not.toMatch(/active && \(?\s*<LocalRecorderCard/);
    expect(source).toContain("if (!homeShown) setSheet(null);");
  });

  test("something landing re-lists the Library: the recorder's save, an upload's, a notetaker's", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    // Every source of "something landed" emits: the recorder's save (App), an
    // upload's saved stage, and a rise in the transcriber's saved count.
    expect(source).toContain('if (uploadStage === "saved" && lastStage.current !== "saved") emitLibraryChanged();');
    expect(source).toContain("if (savedCount > lastSavedCount.current) emitLibraryChanged();");
    const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
    expect(app).toContain('onSaved={() => captureEvents.emit("library-changed")}');
    // useLibrary hears it (library/useLibrary.source.test.ts pins the reads).
    const library = readFileSync(join(import.meta.dir, "library/useLibrary.ts"), "utf8");
    expect(library).toContain('captureEvents.on("library-changed"');
  });
});
