import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlugIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import { MeetingSourcesFeature } from "./MeetingSourcesDialog";
import { meetingSourceStatus } from "./meetingSourceState";
import { SourceRow, type SourceRowProps } from "./MeetingSourcesView";

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
