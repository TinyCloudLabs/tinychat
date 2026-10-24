// What is off while the app uses a node on this computer, and that it is unchanged on the default host:
// the meeting sources (Fireflies, Google Meet), the notetaker action, agent access and the Library's
// meetings. Each shows one line that leads to the "Your own node" section of Settings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ConnectMeetingsLink } from "@/capture/home/desktop/ConnectMeetingsLink";
import { CaptureSurface } from "@/capture/CaptureSurface";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { screenFor } from "../shell/routes";
import { NODE_DISABLED_LINE } from "../lib/nodeHostCopy";
import { AgentAccessControls } from "./AgentEnablementBanner";
import { ConnectorsPage } from "./ConnectorsPage";
import { LocalNodeContext, LocalNodeNotice } from "./LocalNodeNotice";
import { MeetingsSection } from "./MeetingsSection";
import type { UseAgentEnablementResult } from "./useAgentEnablement";

const tcw = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
const sessionStore = {} as SessionStore;
const NOTICE = `data-local-node-notice`;

let restoreDom: (() => void) | undefined;
beforeEach(() => { restoreDom = installDom(); });
afterEach(() => { restoreDom?.(); restoreDom = undefined; });

function inApp(local: boolean, children: React.ReactNode, path = "/chat/capture") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <LocalNodeContext.Provider value={local}>{children}</LocalNodeContext.Provider>
    </MemoryRouter>,
  );
}

const agentState: UseAgentEnablementResult = {
  capability: "available", status: "none", revision: "r1", probeFailed: false, enableError: null, enabling: false,
  disconnecting: false, reconnectReason: null, silentlyEnabled: false,
  onEnable: async () => {}, onDisconnect: async () => {}, onDelegationError: () => {},
};

describe("the line by a control that is off", () => {
  test("is one line that links to the node section of Settings", () => {
    const markup = inApp(true, <LocalNodeNotice />);
    expect(markup).toContain(NODE_DISABLED_LINE);
    expect(markup).toContain('href="/chat/settings#node-address"');
  });
});

describe("meeting sources (Fireflies, Google Meet)", () => {
  test("the Connectors page offers no connect controls on a local node, only the line", () => {
    const markup = inApp(true, <ConnectorsPage tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={sessionStore} />, "/chat/connectors");
    expect(markup).toContain(NOTICE);
    expect(markup).toContain(NODE_DISABLED_LINE);
  });

  test("the Connectors page is unchanged on the default host", () => {
    const markup = inApp(false, <ConnectorsPage tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={sessionStore} />, "/chat/connectors");
    expect(markup).not.toContain(NOTICE);
    expect(markup).toContain("Connectors");
  });

  test("Capture's Connect meetings button is replaced by the line on a local node, and kept on the default host", () => {
    const props = { tcw, backendUrl: "http://127.0.0.1", sessionStore };
    const local = inApp(true, <ConnectMeetingsLink {...props} />);
    expect(local).toContain(NOTICE);
    expect(local).not.toContain('data-testid="capture-connect-meetings"');
    const normal = inApp(false, <ConnectMeetingsLink {...props} />);
    expect(normal).toContain('data-testid="capture-connect-meetings"');
    expect(normal).not.toContain(NOTICE);
  });
});

describe("the meeting notetaker and the Library's meetings", () => {
  function capture(local: boolean) {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={["/chat/capture"]}>
        <LocalNodeContext.Provider value={local}>
          <PlatformContext.Provider value="web">
            <StaticRecorderProvider value={{ available: false }}>
              <CaptureSurface tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={sessionStore} active screen={screenFor("/chat/capture")}
                meetingsSlot={<MeetingsSection backendUrl="http://127.0.0.1" sessionStore={sessionStore} />} />
            </StaticRecorderProvider>
          </PlatformContext.Provider>
        </LocalNodeContext.Provider>
      </MemoryRouter>,
    );
  }

  test("the notetaker action is off on a local node and still offered on the default host", () => {
    expect(capture(true)).not.toContain('aria-label="Send a notetaker to a meeting"');
    expect(capture(false)).toContain('aria-label="Send a notetaker to a meeting"');
  });

  test("the Library shows the line in place of the meetings on a local node", () => {
    expect(capture(true)).toContain(NOTICE);
    expect(capture(false)).not.toContain(NOTICE);
  });
});

describe("agent access", () => {
  const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>.*?<\/button>/g)].map((match) => match[0]);

  test("on a local node Connect agent is disabled, there is no Disconnect, and the line shows", () => {
    const markup = inApp(true, <AgentAccessControls {...agentState} />);
    expect(markup).toContain(NOTICE);
    const connect = buttons(markup).find((button) => button.includes("Connect agent"))!;
    expect(connect).toContain(' disabled=""');
    expect(buttons(markup).some((button) => /disconnect/i.test(button))).toBe(false);
    for (const status of [{ status: null }, { status: null, capability: "unavailable" as const }]) {
      expect(buttons(inApp(true, <AgentAccessControls {...agentState} {...status} />)).some((button) => /disconnect/i.test(button))).toBe(false);
    }
  });

  test("on the default host Connect agent is enabled and no line shows", () => {
    const markup = inApp(false, <AgentAccessControls {...agentState} />);
    expect(markup).not.toContain(NOTICE);
    const connect = buttons(markup).find((button) => button.includes("Connect agent"))!;
    expect(connect).not.toContain(' disabled=""');
    expect(buttons(inApp(false, <AgentAccessControls {...agentState} status={null} />)).some((button) => /disconnect/i.test(button))).toBe(true);
  });
});
