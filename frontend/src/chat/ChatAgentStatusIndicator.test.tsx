import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ChatAgentStatusIndicator } from "./ChatAgentStatusIndicator";
import type { UseAgentEnablementResult } from "./useAgentEnablement";

const baseProps: UseAgentEnablementResult = {
  capability: "available",
  status: "none",
  revision: null,
  enableError: null,
  enabling: false,
  disconnecting: false,
  reconnectReason: null,
  silentlyEnabled: false,
  onEnable: async () => {},
  onDisconnect: async () => {},
  onDelegationError: () => {},
};

function render(props: Partial<UseAgentEnablementResult>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatAgentStatusIndicator {...baseProps} {...props} />
    </MemoryRouter>,
  );
}

describe("ChatAgentStatusIndicator", () => {
  it("shows Connected while tools stay enabled after the toast", () => {
    const html = render({ capability: "enabled", status: "active", silentlyEnabled: false });
    expect(html).toContain("Connected");
    expect(html).toContain("/chat/settings#agent-access");
  });

  it("shows Disconnected with a Connect action", () => {
    const html = render({ capability: "available", status: "none" });
    expect(html).toContain("Disconnected");
    expect(html).toContain("Connect agent");
  });

  it("offers reconnect for stale access", () => {
    const html = render({ capability: "available", status: "stale", reconnectReason: "delegation_stale" });
    expect(html).toContain("Disconnected");
    expect(html).toContain("Reconnect agent");
  });

  it("offers reconnect for expired access", () => {
    const html = render({ capability: "available", status: "expired", reconnectReason: "delegation_expired" });
    expect(html).toContain("Disconnected");
    expect(html).toContain("Reconnect agent");
  });

  it("shows when access could not be verified", () => {
    const html = render({ capability: "available", status: null, reconnectReason: "delegation_unverified" });
    expect(html).toContain("Access could not be verified");
    expect(html).toContain("Reconnect agent");
  });

  it("shows a failed backend probe instead of hiding the status", () => {
    const html = render({ capability: "unavailable", status: null });
    expect(html).toContain("Agent unavailable");
    expect(html).toContain("/chat/settings#agent-access");
  });

  it("shows the initial probe as Checking", () => {
    const html = render({ capability: "probing", status: null });
    expect(html).toContain("Checking…");
  });
});
