// Connectors under the shell (TC-761): one page, one heading, no way back
// (it is a destination), and no Meetings control anywhere in the app's chrome.
// Moved from connectorsNav.test.tsx when that file went (PR6); the Library's
// half ("both meeting data paths") is in capture/library/LibraryListView.test.tsx.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ConnectorsPage } from "./ConnectorsPage";

const CHAT_DIR = join(import.meta.dir);
const read = (name: string) => readFileSync(join(CHAT_DIR, name), "utf8");

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
    expect(page).not.toContain("<LibraryScreen");
    expect(page).not.toContain("VoiceNotesListCard");
    expect(page).not.toContain("meetingsSlot");
    const capture = read("../capture/CaptureSurface.tsx");
    expect(capture).toContain("<UploadSheet");
    expect(capture).toContain("<MeetingSheet");
    expect(capture).toContain("<LibraryScreen");
    expect(capture).toContain("<NoteDetail");
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
