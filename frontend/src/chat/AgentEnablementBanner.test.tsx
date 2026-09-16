import { describe, expect, it } from "bun:test";
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

  it("keeps the first-time enablement copy when no prior delegation failed", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner {...baseProps} reconnectReason={null} />,
    );

    expect(markup).toContain("Connect private agent access");
    expect(markup).toContain(">Connect agent</button>");
    expect(markup).not.toContain("Reconnect");
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
});
