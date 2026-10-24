import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { initialBackgroundSyncState, type BackgroundSyncState } from "@/chat/backgroundSyncState";
import {
  BACKGROUND_SYNC_CONSENT_COPY,
  BACKGROUND_SYNC_TRANSCRIPT_CONSENT_COPY,
} from "@/lib/connectors/consentCopy";
import { DisconnectRow, FirefliesManage, type FirefliesManageProps } from "./ManagePanel";

const noop = () => {};
function props(state: BackgroundSyncState, patch: Partial<FirefliesManageProps> = {}): FirefliesManageProps {
  return {
    connectorName: "Fireflies",
    state,
    consentOpen: false,
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
    expect(html).toContain(">On<");
    expect(html).not.toContain("Enabled in TinyChat");
    expect(html).toContain("Rotate the webhook secret");
    expect(html).toContain("Bring back deleted meetings");
    expect(html).toContain("Disconnect Fireflies");
    expect(html).not.toContain("Live");
  });

  test("unavailable and signed-out read as a plain sentence with an icon, not red", () => {
    const signedOut = render({ ...enabled, phase: "signed-out" });
    expect(signedOut).toContain("Sign in again to manage instant updates.");
    expect(signedOut).toContain("<svg");
    const unavailable = render({ ...enabled, phase: "unavailable" });
    expect(unavailable).toContain("Status unavailable");
    expect(unavailable).toContain("<svg");
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

  test("turning Instant updates on shows the consent first", () => {
    const off: BackgroundSyncState = { ...initialBackgroundSyncState(), phase: "off" };
    expect(render(off)).not.toContain("Turn on instant updates");
    const asked = render(off, { consentOpen: true });
    expect(asked).toContain("Turn on instant updates");
    expect(asked).not.toContain('type="checkbox"');
    expect(asked).not.toContain('aria-disabled="true"');
  });

  test("the consent discloses the transcript-writer grant unless delivery is known to be inactive (TC-641)", () => {
    const off: BackgroundSyncState = { ...initialBackgroundSyncState(), phase: "off" };
    const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    for (const [original, disclosed] of [
      [BACKGROUND_SYNC_CONSENT_COPY, BACKGROUND_SYNC_TRANSCRIPT_CONSENT_COPY],
    ] as const) {
      // No observed status (the default) and an active grant both disclose.
      for (const transcriptConsent of [undefined, "unknown", "active"] as const) {
        const body = text(render(off, { consentOpen: true, transcriptConsent }));
        for (const bullet of disclosed.bullets) expect(body).toContain(text(bullet.replace(/\*/g, "")));
        expect(body).toContain("Notetaker permission");
      }
      // Only a status that says no courier will act keeps the original copy.
      const inactive = text(render(off, { consentOpen: true, transcriptConsent: "inactive" }));
      for (const bullet of original.bullets) expect(inactive).toContain(text(bullet.replace(/\*/g, "")));
      expect(inactive).not.toContain("Notetaker permission");
    }
  });

  test("other sources get Disconnect alone, in red", () => {
    const html = renderToStaticMarkup(<DisconnectRow name="Google Meet" onDisconnect={noop} />);
    expect(html).toContain("Disconnect Google Meet");
    expect(html).toContain("data-danger");
  });
});
