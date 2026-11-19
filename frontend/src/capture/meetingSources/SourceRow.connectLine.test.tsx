// Settings → Connectors (the Meeting sources window) says what Connect does, under
// the Fireflies row's Connect button, every time that button shows. The line does
// not depend on whether the owner connected before, so a disconnect that deleted
// its data reads the same as a first connect.
import { describe, expect, test } from "bun:test";
import { PlugIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import { SourceRow, type SourceRowProps } from "./MeetingSourcesView";
import { meetingSourceStatus } from "./meetingSourceState";

const LINE = "Connecting imports your meetings from Fireflies.";
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

describe("Fireflies row: the line under Connect", () => {
  test("shows right after the Connect button", () => {
    const html = render({});
    expect(html).toContain(">Connect</button>");
    expect(html.indexOf(LINE)).toBeGreaterThan(html.indexOf(">Connect</button>"));
  });

  test("does not show while connected", () => {
    expect(render({ connected: true })).not.toContain(LINE);
  });

  test("does not show while the connection is being read or when the read failed", () => {
    expect(render({ lookup: "loading" })).not.toContain(LINE);
    expect(render({ lookup: "failed" })).not.toContain(LINE);
  });

  test("does not show on another connector's Connect button", () => {
    const html = render({ id: "google-meet", name: "Google Meet", description: "Google Meet transcripts." });
    expect(html).toContain(">Connect</button>");
    expect(html).not.toContain(LINE);
  });
});
