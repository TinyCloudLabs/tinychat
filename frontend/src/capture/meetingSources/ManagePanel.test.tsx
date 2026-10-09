import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { initialBackgroundSyncState, type BackgroundSyncState } from "@/chat/backgroundSyncState";
import { DisconnectRow, FirefliesManage, type FirefliesManageProps } from "./ManagePanel";

const noop = () => {};
function props(state: BackgroundSyncState, patch: Partial<FirefliesManageProps> = {}): FirefliesManageProps {
  return {
    connectorName: "Fireflies",
    state,
    consentVariant: "C",
    ingestConsentChecked: false,
    consentOpen: false,
    onIngestConsentChange: noop,
    onToggleInstant: noop,
    onConfirmEnable: noop,
    onCancelEnable: noop,
    onRotate: noop,
    onDismissReveal: noop,
    onCopy: noop,
    onSync: noop,
    onRetry: noop,
    onBringBack: noop,
    onDisconnect: noop,
    ...patch,
  };
}
const render = (state: BackgroundSyncState, patch?: Partial<FirefliesManageProps>) =>
  renderToStaticMarkup(<FirefliesManage {...props(state, patch)} />);
const enabled: BackgroundSyncState = { ...initialBackgroundSyncState(), phase: "enabled", hasSecret: true };

describe("Fireflies Manage panel", () => {
  test("Instant updates is a switch that mirrors the state", () => {
    expect(render(enabled)).toContain('role="switch"');
    expect(render(enabled)).toContain('aria-checked="true"');
    expect(render({ ...enabled, phase: "off" })).toContain('aria-checked="false"');
  });

  test("Checking… shows while the first read is in flight, and only here", () => {
    expect(render(initialBackgroundSyncState())).toContain("Checking…");
    expect(render(enabled)).not.toContain("Checking…");
  });

  test("an enabled connection says what it is and offers Rotate, Bring back and Disconnect", () => {
    const html = render(enabled);
    expect(html).toContain("Enabled in TinyChat");
    expect(html).toContain("Rotate the webhook secret");
    expect(html).toContain("Bring back deleted meetings");
    expect(html).toContain("Disconnect Fireflies");
    expect(html).not.toContain("Live");
  });

  test("nothing about instant updates renders when the route is dark, but Disconnect stays", () => {
    const html = render({ ...initialBackgroundSyncState(), phase: "dark" });
    expect(html).not.toContain("Instant updates");
    expect(html).toContain("Disconnect Fireflies");
  });

  test("Rotate is hidden while the one-time secret is on screen", () => {
    const html = render({
      ...enabled,
      reveal: { url: "https://example.test/hook", secret: "s3cret", rotated: true },
    });
    expect(html).not.toContain("Rotate the webhook secret");
    expect(html).toContain("data-reveal-done");
    expect(html).toContain("previous address and secret have stopped working");
  });

  test("turning Instant updates on shows the consent first; the cohort variant needs the attestation", () => {
    const off: BackgroundSyncState = { ...initialBackgroundSyncState(), phase: "off" };
    expect(render(off)).not.toContain("Turn on instant updates");
    const asked = render(off, { consentOpen: true });
    expect(asked).toContain("Turn on instant updates");
    expect(asked).not.toContain('type="checkbox"');
    const cohort = render(off, { consentOpen: true, consentVariant: "B-ingest" });
    expect(cohort.match(/type="checkbox"/g)).toHaveLength(1);
    expect(cohort).toContain('aria-disabled="true"');
  });

  test("other sources get Disconnect alone, in red", () => {
    const html = renderToStaticMarkup(<DisconnectRow name="Google Meet" onDisconnect={noop} />);
    expect(html).toContain("Disconnect Google Meet");
    expect(html).toContain("data-danger");
  });
});
