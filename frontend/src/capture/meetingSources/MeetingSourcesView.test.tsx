import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlugIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONNECTORS } from "@/lib/connectors/registry";
import { MeetingSourcesFeature } from "./MeetingSourcesDialog";
import { meetingSourceStatus } from "./meetingSourceState";
import { CalendarAutojoinRow, DisconnectDataChoice, SourceRow, type SourceRowProps } from "./MeetingSourcesView";
import { DISCONNECT_WHILE_SYNCING, DisconnectRow } from "./ManagePanel";
import { sourceRowDisplay } from "./meetingSourceState";

const noop = () => {};
function render(patch: Partial<SourceRowProps>): string {
  return renderToStaticMarkup(
    <SourceRow
      id="fireflies"
      name="Fireflies"
      description="Meeting transcripts from Fireflies.ai."
      Icon={PlugIcon}
      status={meetingSourceStatus("disconnected")}
      lookup="ready"
      connected={false}
      busy={false}
      syncing={false}
      manageOpen={false}
      onConnect={noop}
      onRetryLookup={noop}
      onSync={noop}
      onToggleManage={noop}
      {...patch}
    />,
  );
}

describe("Meeting sources row connection read", () => {
  test("Connect is offered only after a confirmed not-connected", () => {
    const html = render({ lookup: "ready" });
    expect(html).toContain("Not connected");
    expect(html).toContain(">Connect<");
  });

  test("while loading the row is a quiet pulsing dot with no action", () => {
    const html = render({ lookup: "loading" });
    expect(html).toContain('data-tone="busy"');
    expect(html).not.toContain("Not connected");
    expect(html).not.toContain("<button");
  });

  test("a failed read is a visible row error with Try again, never Connect", () => {
    const html = render({ lookup: "failed" });
    expect(html).toContain("Couldn&#x27;t check Fireflies");
    expect(html).toContain('role="alert"');
    expect(html).toContain(">Try again<");
    expect(html).not.toContain("Not connected");
    expect(html).not.toContain(">Connect<");
  });

  test("row errors carry an icon and no red", () => {
    const html = render({ error: "Sync failed. Try again.", connected: true, status: meetingSourceStatus("connected", "now", 1) });
    expect(html).toContain("Sync failed. Try again.");
    expect(html).toContain("ms-row-error");
    expect(html).toContain("<svg");
  });
});

describe("Sync now, Full rescan and Stop", () => {
  const connected = { connected: true, status: meetingSourceStatus("connected", "now", 3) };

  test("Google Meet offers Full rescan beside Sync now; Fireflies does not", () => {
    const meet = render({ ...connected, id: "google-meet", name: "Google Meet", onFullRescan: noop });
    expect(meet).toContain(">Full rescan<");
    expect(meet).toContain(">Sync now<");
    expect(render(connected)).not.toContain("Full rescan");
  });

  test("Full rescan is inert while a sync runs", () => {
    const html = render({ ...connected, onFullRescan: noop, busy: true, syncing: true, onStop: noop });
    expect(html).toMatch(/aria-disabled="true"[^>]*>Full rescan</);
  });

  test("a sync this window owns offers Stop and the live count", () => {
    const html = render({ ...connected, busy: true, syncing: true, syncLabel: "Syncing 3/12…", onStop: noop });
    expect(html).toContain("Syncing 3/12…");
    expect(html).toContain('aria-label="Stop syncing Fireflies"');
  });

  test("a sync this window only joined has no Stop and says who owns it", () => {
    const html = render({ ...connected, busy: true, syncing: true, joined: true, onStop: noop });
    expect(html).not.toContain("Stop syncing");
    expect(html).toContain("still running — this one joined it");
  });

  test("an open Manage panel cannot disconnect while the sync runs", () => {
    const running = renderToStaticMarkup(<DisconnectRow name="Fireflies" syncing onDisconnect={noop} />);
    expect(running).toMatch(/aria-disabled="true"[^>]*>Disconnect Fireflies</);
    expect(running).toContain(DISCONNECT_WHILE_SYNCING);
    const idle = renderToStaticMarkup(<DisconnectRow name="Fireflies" onDisconnect={noop} />);
    expect(idle).toMatch(/aria-disabled="false"[^>]*>Disconnect Fireflies</);
    expect(idle).not.toContain(DISCONNECT_WHILE_SYNCING);
  });
});

describe("a saved failure reaches the row", () => {
  test("starting from a persisted failed connection, the reopened row says so and shows the reason", () => {
    const row = sourceRowDisplay({
      comingSoon: false,
      connection: {
        status: "connected",
        lastSyncedAt: "2026-10-09T11:00:00Z",
        lastSyncStatus: "error",
        lastSyncError: "Couldn't reach Google with your saved connection. Try reconnecting Google Meet.",
        itemCount: 7,
      },
      syncing: false,
      connecting: false,
      syncError: null,
      rowNote: null,
    });
    const html = render({ connected: true, status: row.status, error: row.error });
    expect(html).toContain("Last sync failed");
    expect(html).toContain("Try reconnecting Google Meet.");
    expect(html).toContain('role="alert"');
  });
});

describe("the disconnect choice", () => {
  const choice = (patch: Partial<Parameters<typeof DisconnectDataChoice>[0]> = {}) =>
    renderToStaticMarkup(
      <DisconnectDataChoice name="Fireflies" oauth={false} itemCount={5} checked={false} disabled={false} onChange={noop} {...patch} />,
    );

  test("offers to delete the synced meetings, unchecked by default", () => {
    const html = choice();
    expect(html).toContain("Also delete the 5 synced meetings from my space.");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("checked");
    expect(html).toContain("recorded with the server first");
  });

  test("Google Meet's copy talks about transcripts, a single meeting is singular", () => {
    expect(choice({ oauth: true, itemCount: 1 })).toContain("Also delete the 1 synced meeting from my space.");
    expect(choice({ oauth: true })).toContain("removed along with their transcripts");
  });

  test("is not offered when nothing is synced, and locks once a teardown has begun", () => {
    expect(choice({ itemCount: 0 })).toBe("");
    expect(choice({ checked: true, disabled: true })).toMatch(/checked=""[^>]*disabled=""|disabled=""[^>]*checked=""/);
  });
});

describe("Connectors entry card", () => {
  test("never says Checking…: it shows the neutral line until the summary is known", () => {
    const html = renderToStaticMarkup(
      <MeetingSourcesFeature
        tcw={{} as TinyCloudWeb}
        backendUrl="https://x.test"
        sessionStore={{} as SessionStore}
      />,
    );
    expect(html).not.toContain("Checking");
    expect(html).toContain('class="ms-entry-sub">Fireflies, Google Meet and Granola</span>');
    expect(html).toContain("<span>Meeting sources</span>");
  });
});

describe("one Meeting sources view", () => {
  const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

  test("the registry is the one table of source descriptions", () => {
    expect(read("MeetingSourcesDialog.tsx")).not.toContain("DESCRIPTIONS");
    expect(read("MeetingSourcesDialog.tsx")).toContain("description={d.description}");
    expect(CONNECTORS.map((d) => d.description)).toEqual([
      "Meeting transcripts from Fireflies.ai.",
      "Notes and transcripts from Granola.",
      "Google Meet transcripts and Notes by Gemini.",
    ]);
  });

  test("Calendar autojoin carries no How it works of its own (the window header has the one)", () => {
    const html = renderToStaticMarkup(
      <CalendarAutojoinRow on={false} disabled={false} scan="none yet" warning={null} onToggle={noop} />,
    );
    expect(html).not.toContain("How it works");
  });

  test("on a phone width a row's actions go under its text", () => {
    const css = read("meetingSources.css");
    const phone = css.slice(css.indexOf("@media (max-width: 560px)"));
    expect(phone).toContain("grid-template-columns: 40px minmax(0, 1fr)");
    expect(phone).toMatch(/\.ms-actions \{\s*grid-column: 2;\s*flex-wrap: wrap;/);
    expect(phone).toContain("grid-column: 2 / -1");
  });
});
