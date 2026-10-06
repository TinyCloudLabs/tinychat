// The Connectors and Library information architecture after the shell
// (TC-761):
//
//     Capture → Library → Meetings        (/chat/capture/library)
//     Connectors                           (/chat/connectors, one page)
//
// What is left of connectorsNav (the Library categories and the legacy path
// constants) is pure, so its markup is asserted for real with
// `react-dom/server`. The surfaces it is wired into pull in
// `@tinycloud/web-sdk`-typed modules that render fine on the server, or are
// asserted against their source where they need a browser. The routing rules
// themselves moved to shell/routes.test.ts.
//
// The rules:
//
//   1. Library is a Capture screen, and Meetings is its only current category
//      — no disabled/speculative Docs UI ships, but the category list is an
//      array a Documents entry drops into;
//   2. the standalone top-header Meetings control stays GONE (there is no app
//      header any more; the shell and the chat header carry none), and the
//      old /chat/meetings and /chat/connectors/library links forward to the
//      Library (shell/routes.test.ts);
//   3. Connectors has ONE page heading and no back affordance — it is a
//      destination, and the shell's navigation is always on screen;
//   4. Library keeps BOTH meeting data paths — the user's own space and the
//      cohort read API — under one surface.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { PATHS } from "../shell/routes";
import { ConnectorsPage } from "./ConnectorsPage";
import {
  CONNECTORS_LIBRARY_PATH,
  CONNECTORS_SOURCES_PATH,
  LIBRARY_CATEGORIES,
  LibraryCategoryNav,
} from "./connectorsNav";

const CHAT_DIR = join(import.meta.dir);
const read = (name: string) => readFileSync(join(CHAT_DIR, name), "utf8");

describe("Library categories", () => {
  test("Meetings is the only category shipped today, and it lives under Capture", () => {
    expect(LIBRARY_CATEGORIES.map((c) => c.id)).toEqual(["meetings"]);
    expect(LIBRARY_CATEGORIES[0]!.label).toBe("Meetings");
    expect(LIBRARY_CATEGORIES[0]!.to).toBe(PATHS.library);
  });

  test("no disabled or speculative Documents UI is rendered", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryCategoryNav active="meetings" />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Documents");
    expect(html).not.toContain("Docs");
    expect(html).not.toContain("disabled");
    // A single category needs no chooser — the nav appears when a second one
    // (Documents) is added to LIBRARY_CATEGORIES, and not before.
    expect(html).toBe("");
  });

  test("the old Connectors addresses are kept as constants for the legacy forward", () => {
    expect(CONNECTORS_SOURCES_PATH).toBe(PATHS.connectors);
    expect(CONNECTORS_LIBRARY_PATH).toBe("/chat/connectors/library");
  });
});

describe("Connectors page composition under the new IA", () => {
  const tcw = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <ConnectorsPage tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={{} as SessionStore} />
    </MemoryRouter>,
  );

  test("one page heading, and no back affordance", () => {
    expect(markup.match(/<h1/g)).toHaveLength(1);
    const heading = markup.slice(markup.indexOf("<h1"), markup.indexOf("</h1>"));
    expect(heading).toContain(">Connectors<");
    // A destination: the shell's navigation is the way elsewhere.
    expect(markup).not.toContain("Back to chat");
    expect(markup).not.toContain(">Back<");
    const page = read("ConnectorsPage.tsx");
    expect(page).not.toContain("onBack");
    expect(page).not.toContain("ArrowLeftIcon");
  });

  test("Connectors owns the connector rows; Capture owns capture and the Library", () => {
    const page = read("ConnectorsPage.tsx");
    expect(page).toContain("<ConnectorsCard");
    expect(page).not.toContain("<TranscriberSection");
    expect(page).not.toContain("<LibraryPage");
    expect(page).not.toContain("VoiceNotesListCard");
    expect(page).not.toContain("meetingsSlot");
    const capture = read("../capture/CaptureSurface.tsx");
    expect(capture).toContain("<UploadSheet");
    expect(capture).toContain("<MeetingSheet");
    expect(capture).toContain("<LibraryPage");
    expect(capture).toContain("<VoiceNotesListCard");
  });

  test("Library keeps BOTH meeting data paths", () => {
    // The user's own space (MeetingsPage, via tcw) and the cohort read API
    // (the App-owned meetingsSlot) both live under Library → Meetings.
    const library = read("LibraryPage.tsx");
    expect(library).toContain("<MeetingsPage");
    expect(library).toContain("meetingsSlot");
    expect(library).toContain("LIBRARY_CATEGORIES");
  });

  test("the meetings explorer no longer owns page chrome", () => {
    // It renders inside Library; the page header and the way back belong to
    // the Library screen around it.
    const meetings = read("MeetingsPage.tsx");
    expect(meetings).not.toContain("onBack");
    expect(meetings).not.toContain("Back to chat");
    expect(meetings).not.toContain("<h1");
  });
});

describe("no standalone Meetings control in the app's chrome", () => {
  const shellDir = join(CHAT_DIR, "../shell");
  const chrome = [
    ...readdirSync(shellDir)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
      .map((name) => [`shell/${name}`, readFileSync(join(shellDir, name), "utf8")] as const),
    ["chat/ChatHeader.tsx", read("ChatHeader.tsx")] as const,
  ];

  test("the shell and the chat header carry no Meetings button", () => {
    for (const [, source] of chrome) {
      expect(source).not.toContain("CalendarClockIcon");
      expect(source).not.toMatch(/>\s*Meetings\s*</);
      expect(source).not.toContain('"Meetings"');
    }
  });

  test("App routes through the shell's routes, with no Meetings surface of its own", () => {
    const app = read("../App.tsx");
    expect(app).toContain("screenFor(location.pathname)");
    expect(app).not.toContain("<header");
    expect(app).not.toContain("<MeetingsPage");
    expect(app).not.toContain("showMeetings");
  });
});
