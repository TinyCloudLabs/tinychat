// Capture's fixed tree (TC-761): the home and the Library are both mounted and
// only `hidden` moves between them; Record and the Voice notes list exist only
// while Capture is on screen. The panes are rendered on the server (as the web
// app, where there is no recorder); test/shell-invariants.e2e.test.ts counts the
// recorder's listeners in a browser with the fake plugin.
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
  test("on Capture: home shows, the Library is mounted and hidden", () => {
    const markup = render("/chat/capture", true);
    expect(pane(markup, "capture-home").classes).not.toContain("hidden");
    expect(pane(markup, "capture-library").classes).toEqual(["hidden"]);
    // Home: the title, the gear and the Library link; the Upload and Meeting actions.
    expect(markup).toContain(">Capture</span>");
    expect(markup).toContain('href="/chat/capture/library"');
    expect(markup).toContain('aria-label="Upload audio"');
    expect(markup).toContain('aria-label="Send a notetaker to a meeting"');
    // The Library is there, with both meeting data paths.
    expect(markup).toContain(">Synced meetings<");
    expect(markup).toContain("cohort-meetings");
  });

  test("on the Library: the Library shows with Back, and the home cards stay mounted", () => {
    const markup = render("/chat/capture/library", true);
    expect(pane(markup, "capture-home").classes).toEqual(["hidden"]);
    expect(pane(markup, "capture-library").classes).not.toContain("hidden");
    expect(pane(markup, "capture-library").after).toContain(">Back</button>");
    // The home (and a desktop local recording in it) is still mounted.
    expect(pane(markup, "capture-home").after).toContain('data-testid="capture-actions"');
  });

  test("Record and the Voice notes list exist only while Capture is on screen", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    expect(source.match(/<VoiceNotesListCard/g)).toHaveLength(1);
    expect(source).toMatch(/\{active && \(\s*<>\s*<RecordButton variant="bar" \/>\s*<VoiceNotesListCard/);
    // App and the harness hand `active` from the screen's destination.
    const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
    expect(app).toContain('active={screen.destination === "capture"}');
  });

  test("the desktop local recorder is mounted whatever shows, and the sheets close when the home is left", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    // Never behind `active`: unmounting the panel stops a recording without saving it.
    expect(source).toContain("{localRecorder && <LocalRecorderCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />}");
    expect(source).not.toMatch(/active && \(?\s*<LocalRecorderCard/);
    expect(source).toContain("if (!homeShown) setSheet(null);");
  });

  test("the Library reads through the per-space queue, and re-lists on entry and when something lands", () => {
    const source = readFileSync(join(import.meta.dir, "CaptureSurface.tsx"), "utf8");
    expect(source).toContain("<LibraryPage tcw={scheduledSpace(tcw)} meetingsSlot={meetingsSlot} listSignal={listSignal} />");
    expect(source).toContain('captureEvents.on("library-changed"');
    // Every source of "something landed" emits: the recorder's save (App), an
    // upload's saved stage, and a rise in the transcriber's saved count.
    expect(source).toContain('if (uploadStage === "saved" && lastStage.current !== "saved") emitLibraryChanged();');
    expect(source).toContain("if (savedCount > lastSavedCount.current) emitLibraryChanged();");
    const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
    expect(app).toContain('onSaved={() => captureEvents.emit("library-changed")}');
    // MeetingsPage re-reads when the signal changes.
    const meetings = readFileSync(join(import.meta.dir, "../chat/MeetingsPage.tsx"), "utf8");
    expect(meetings).toContain("}, [tcw, listSignal]);");
  });
});
