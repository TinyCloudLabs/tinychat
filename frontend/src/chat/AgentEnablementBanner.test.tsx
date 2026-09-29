import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentAccessControls, AgentEnablementBanner } from "./AgentEnablementBanner";
import { CONNECTORS_LIBRARY_PATH, CONNECTORS_SOURCES_PATH } from "./connectorsNav";

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


// App.tsx pulls in @tinycloud/web-sdk, which a bun test process cannot
// evaluate, so its wiring is asserted against the source (as
// connectorsNav.test.tsx does), and the route → view flags are rebuilt from
// App's own matchers rather than restated here.
describe("App mounts the banner on chat views only", () => {
  const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
  const workspace = app.slice(
    app.indexOf("function ChatWorkspace("),
    app.indexOf("function SharedThreadSurface("),
  );

  const connectorsRoute = new RegExp(
    app.match(/const showConnectors = !LOCAL_VALIDATION && \/(.+)\/\.test\(location\.pathname\);/)![1],
  );
  const settingsSuffix = app.match(
    /const showSettings = !LOCAL_VALIDATION && location\.pathname\.endsWith\("([^"]+)"\);/,
  )![1];
  const bannerShownOn = (pathname: string) =>
    !connectorsRoute.test(pathname) && !pathname.endsWith(settingsSuffix);

  it("gates the only banner mount on the existing Connectors and Settings view flags", () => {
    expect(app.split("<AgentEnablementBanner")).toHaveLength(2);
    expect(workspace).toContain("{!showConnectors && !showSettings && (\n        <AgentEnablementBanner");
    expect(workspace).toContain("const { showConnectors, showSettings, pendingMeetings } = props;");
    expect(app).toContain("showConnectors={showConnectors}\n                showSettings={showSettings}");
  });

  it("shows on the chat view", () => {
    expect(bannerShownOn("/chat")).toBe(true);
  });

  it("hides on Connectors (Sources and Library) and Settings", () => {
    expect(bannerShownOn(CONNECTORS_SOURCES_PATH)).toBe(false);
    expect(bannerShownOn(CONNECTORS_LIBRARY_PATH)).toBe(false);
    expect(bannerShownOn("/chat/settings")).toBe(false);
  });
});
