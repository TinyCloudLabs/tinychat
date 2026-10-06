import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentAccessControls, AgentEnablementBanner } from "./AgentEnablementBanner";

describe("AgentEnablementBanner", () => {
  const baseProps = {
    capability: "available" as const,
    enableError: null,
    enabling: false,
    onEnable: async () => {},
    silentlyEnabled: false,
  };

  it("offers an explicit reconnect action after transcript access expires", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner
        {...baseProps}
        reconnectReason="delegation_expired"
      />,
    );

    expect(markup).toContain("Private agent access expired");
    expect(markup).toContain("Reconnect");
    expect(markup).toContain("private meeting transcripts again");
  });

  it("says a failed check could not be verified instead of claiming expiry", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner {...baseProps} reconnectReason="delegation_unverified" />,
    );

    expect(markup).toContain("Couldn&#x27;t verify private agent access");
    expect(markup).toContain("Reconnect if this keeps happening.");
    expect(markup).toContain(">Reconnect agent</button>");
    expect(markup).not.toContain("expired");
  });

  it("asks to reconnect when a turn reports missing access", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner {...baseProps} reconnectReason="delegation_required" />,
    );

    expect(markup).toContain("Private agent access needs reconnecting");
    expect(markup).toContain(">Reconnect agent</button>");
  });

  it("keeps the first-time enablement copy when no prior delegation failed", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner {...baseProps} reconnectReason={null} />,
    );

    expect(markup).toContain("Connect private agent access");
    expect(markup).toContain(">Connect agent</button>");
    expect(markup).not.toContain("Reconnect");
    expect(markup).toContain("sign with your passkey");
  });

  it("does not promise a passkey where OpenKey offers none (desktop)", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner {...baseProps} reconnectReason={null} passkeysSupported={false} />,
    );

    expect(markup).toContain("sign in with OpenKey once to authorize access");
    expect(markup).not.toContain("passkey");
  });
});


describe("Settings agent controls", () => {
  const props = {
    capability: "enabled" as const, status: "active" as const, revision: "r",
    enableError: null, enabling: false, disconnecting: false, reconnectReason: null,
    silentlyEnabled: false, onEnable: async () => {}, onDisconnect: async () => {}, onDelegationError: () => {},
  };
  it("shows both reconnect and disconnect while connected", () => {
    const html = renderToStaticMarkup(<AgentAccessControls {...props} />);
    expect(html).toContain("Reconnect agent"); expect(html).toContain("Disconnect agent");
    expect(html).toContain("Public web search stays available.");
  });
  it("shows Connect after confirmed disconnection and keeps failures distinct", () => {
    const html = renderToStaticMarkup(<AgentAccessControls {...props} capability="available" status="none" />);
    expect(html).toContain("Connect agent"); expect(html).toContain("Disconnected");
    const failure = renderToStaticMarkup(<AgentAccessControls {...props} capability="available" status={null} enableError="Disconnection was not confirmed." />);
    expect(failure).toContain("Access status unknown"); expect(failure).not.toContain(">Disconnected<");
    expect(failure).toContain("Retry disconnect");
  });
  it("distinguishes an unverified check from a disconnect and offers Reconnect", () => {
    const html = renderToStaticMarkup(<AgentAccessControls {...props} capability="available" status={null} reconnectReason="delegation_unverified" />);
    expect(html).toContain("Access could not be verified");
    expect(html).toContain("Reconnect agent");
    expect(html).toContain("Disconnect agent");
    expect(html).not.toContain("Retry disconnect");
    const expired = renderToStaticMarkup(<AgentAccessControls {...props} capability="available" status="expired" reconnectReason="delegation_expired" />);
    expect(expired).toContain("Disconnected"); expect(expired).toContain("Reconnect agent");
  });
});


// App.tsx pulls in @tinycloud/web-sdk, which a bun test process cannot
// evaluate, so its wiring is asserted against the source (as
// connectorsNav.test.tsx does). The route gate itself is unit-tested in
// chatViewPath.test.ts and exercised on real navigation in
// test/agent-banner-route.e2e.test.ts.
describe("App mounts the banner through the chat-view gate", () => {
  const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");

  it("mounts only the chat-view-gated banner, never the bare one", () => {
    expect(app.split("<ChatViewAgentEnablementBanner />")).toHaveLength(2);
    expect(app).not.toContain("<AgentEnablementBanner");
  });

  it("the gate is the positive chat-view classifier", () => {
    const banner = readFileSync(join(import.meta.dir, "AgentEnablementBanner.tsx"), "utf8");
    const gate = banner.slice(banner.indexOf("export function ChatViewAgentEnablementBanner("));
    expect(gate).toContain("if (!isChatViewPath(pathname)) return null;");
  });
});
