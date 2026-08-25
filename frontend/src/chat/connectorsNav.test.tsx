// RED-first tests for the Connectors information architecture:
//
//     Connectors → Sources | Library → Meetings
//
// The nav itself (`connectorsNav.tsx`) is pure — no `tcw`, no session, no
// storage — so its markup is asserted for real with `react-dom/server`, the
// same renderer MeetingsSection.test.tsx uses. The surfaces it is wired into
// (`ConnectorsPage`, `LibraryPage`, `App`) pull in `@tinycloud/web-sdk`, which
// a bun test process cannot evaluate, so their wiring is asserted against the
// source the way ConnectorsCard.test.ts does.
//
// The rules:
//
//   1. Sources and Library are PEER tabs of one Connectors page, each a real
//      link to its own route, with the active one marked for assistive tech;
//   2. `/chat/connectors/library` is the canonical Library route and Meetings
//      is its only current category — no disabled/speculative Docs UI ships,
//      but the category list is an array a Documents entry drops into;
//   3. the standalone top-header Meetings control is GONE, and the old
//      `/chat/meetings` link forwards to the canonical Library route;
//   4. Connectors has ONE page header and no "Back to chat" — the persistent
//      chat sidebar is the way back, on desktop and mobile;
//   5. Library keeps BOTH meeting data paths — the user's own space and the
//      cohort read API — under one surface.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import {
  CONNECTORS_LIBRARY_PATH,
  CONNECTORS_SOURCES_PATH,
  ConnectorsTabs,
  LIBRARY_CATEGORIES,
  LibraryCategoryNav,
} from "./connectorsNav";

const CHAT_DIR = join(import.meta.dir);
const read = (name: string) => readFileSync(join(CHAT_DIR, name), "utf8");

const renderTabs = (active: "sources" | "library") =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ConnectorsTabs active={active} />
    </MemoryRouter>,
  );

describe("Connectors tabs", () => {
  test("Sources and Library are peer links inside a labelled nav", () => {
    const html = renderTabs("sources");
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Connectors sections"');
    expect(html).toContain(`href="${CONNECTORS_SOURCES_PATH}"`);
    expect(html).toContain(`href="${CONNECTORS_LIBRARY_PATH}"`);
    expect(html).toContain(">Sources<");
    expect(html).toContain(">Library<");
  });

  test("the canonical Library route is /chat/connectors/library", () => {
    expect(CONNECTORS_LIBRARY_PATH).toBe("/chat/connectors/library");
    expect(CONNECTORS_SOURCES_PATH).toBe("/chat/connectors");
  });

  /** The opening `<a …>` tag whose href is `to` — attribute order is React's. */
  const anchorFor = (html: string, to: string) =>
    html
      .split("<a ")
      .map((chunk) => chunk.slice(0, chunk.indexOf(">")))
      .find((tag) => tag.includes(`href="${to}"`))!;

  test("exactly the active tab carries aria-current", () => {
    const onLibrary = renderTabs("library");
    // One marked tab, and it is the Library link.
    expect(onLibrary.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchorFor(onLibrary, CONNECTORS_LIBRARY_PATH)).toContain(
      'aria-current="page"',
    );

    const onSources = renderTabs("sources");
    expect(onSources.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchorFor(onSources, CONNECTORS_SOURCES_PATH)).toContain(
      'aria-current="page"',
    );
  });

  test("tabs keep a mobile-sized touch target", () => {
    // Same floor the sidebar and header controls hold themselves to.
    expect(renderTabs("sources")).toContain("min-h-11");
  });
});

describe("Library categories", () => {
  test("Meetings is the only category shipped today", () => {
    expect(LIBRARY_CATEGORIES.map((c) => c.id)).toEqual(["meetings"]);
    expect(LIBRARY_CATEGORIES[0]!.label).toBe("Meetings");
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
});

describe("Connectors page composition under the new IA", () => {
  test("one stable page header, tabs, and no Back to chat", () => {
    const page = read("ConnectorsPage.tsx");
    expect(page).toContain("<ConnectorsTabs");
    // No back affordance of its own: the persistent sidebar is the way back.
    expect(page).not.toContain('aria-label="Back to chat"');
    expect(page).not.toContain("ArrowLeftIcon");
    expect(page).not.toContain("onBack");
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain(">Connectors<");
  });

  test("Sources owns the setup/capture UI, Library owns the browsable content", () => {
    const page = read("ConnectorsPage.tsx");
    expect(page).toContain("<ConnectorsCard");
    expect(page).toContain("<TranscriberSection");
    expect(page).toContain("<LibraryPage");
    // The synced archive is no longer a card bolted to the bottom of setup.
    const sources = page.slice(page.indexOf("<ConnectorsCard"));
    expect(sources.indexOf("meetingsSlot")).toBe(-1);
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
    // It renders inside Library now; the page header and the back affordance
    // belong to Connectors and the persistent sidebar.
    const meetings = read("MeetingsPage.tsx");
    expect(meetings).not.toContain("onBack");
    expect(meetings).not.toContain("Back to chat");
    expect(meetings).not.toContain("<h1");
  });
});

describe("App routing under the new IA", () => {
  const app = read("../App.tsx");
  const header = app.slice(app.indexOf("<header"), app.indexOf("</header>"));

  test("the standalone top-header Meetings button is gone", () => {
    expect(header).not.toContain("Meetings");
    expect(header).not.toContain("CalendarClockIcon");
  });

  test("the connectors surface matches its nested Library route", () => {
    // `endsWith("/chat/connectors")` cannot see /chat/connectors/library, so
    // the match has to span the nested route for the sidebar entry to stay
    // active — and for the workspace to keep rendering Connectors — there.
    expect(app).not.toContain('location.pathname.endsWith("/chat/connectors")');
    expect(app).toContain("const showConnectors = /\\/chat\\/connectors(\\/|$)/");
    // The open tab comes from the route, and the route constants are the
    // module's — App never rebuilds either address by hand.
    expect(app).toContain("connectorsTabFor(location.pathname)");
    expect(app).toContain("tab={connectorsTab}");
    expect(app).toContain("navigate(CONNECTORS_SOURCES_PATH)");
  });

  test("the old /chat/meetings link forwards to the canonical Library route", () => {
    expect(app).toContain('location.pathname.endsWith("/chat/meetings")');
    const forward = app.slice(app.indexOf("if (!legacyMeetings) return;"));
    expect(forward.slice(0, forward.indexOf("}, ["))).toContain(
      "navigate(isReady ? CONNECTORS_LIBRARY_PATH",
    );
    expect(forward.slice(0, forward.indexOf("}, ["))).toContain("replace: true");
    // No second meetings surface left behind at the old address.
    expect(app).not.toContain("<MeetingsPage");
    expect(app).not.toContain("showMeetings");
  });
});
