import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentEnablementBanner } from "./AgentEnablementBanner";

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

    expect(markup).toContain("Enable agent memory &amp; tools");
    expect(markup).toContain(">Enable</button>");
    expect(markup).not.toContain("Reconnect");
  });
});
