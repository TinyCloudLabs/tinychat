// The REAL ChatWorkspace, by build: the Home site builds the browser meeting retriever (which reads the connectors
// databases and asks the meetings route) only once Connectors is permitted, and never shows the agent-access banner
// (which offers meeting access); the plain build still does both.
// Run by src/chat/ChatWorkspace.homeGrant.test.ts in its own process.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { createRuntimeShim } from "@/harness/runtimeShim";
import { harnessSessionStore, harnessTcw } from "@/harness/stubs";

const HOME = process.env.VITE_HOME_SITE === "true";

const restoreImportDom = installDom();
const retrieverApi = await import("@/lib/meetingChat/retriever");
const agentApi = await import("@/chat/useAgentEnablement");
// Taken before the mocks are installed: a module namespace is live, so reading it later returns the mock.
const realCreateRetriever = retrieverApi.createBrowserMeetingTurnRetriever;
const { AgentAccessProvider, useAgentAccess: realUseAgentAccess } = agentApi;
let retrieversBuilt = 0;
mock.module("@/lib/meetingChat/retriever", () => ({
  ...retrieverApi,
  createBrowserMeetingTurnRetriever: (...args: Parameters<typeof realCreateRetriever>) => {
    retrieversBuilt += 1;
    return realCreateRetriever(...args);
  },
}));
// The backend probe says agent access is available.
mock.module("@/chat/useAgentEnablement", () => ({
  ...agentApi,
  useAgentAccess: () => ({ ...realUseAgentAccess(), capability: "available" as const, reconnectReason: null, enableError: null, enabling: false }),
}));
const { ChatWorkspace } = await import("@/chat/ChatWorkspace");
const { HomeFeatureAccessContext } = await import("@/shell/homeFeatureAccess");
restoreImportDom();

let restoreDom: () => void;
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  retrieversBuilt = 0;
  restoreDom = installDom();
  Object.assign(globalThis, { ResizeObserver: NoopObserver });
});
afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  restoreDom();
});

async function mountChat(connectorsPermitted?: boolean) {
  const shim = createRuntimeShim();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const backendUrl = "http://localhost";
  const chat = (
    <AgentAccessProvider tcw={harnessTcw} sessionStore={harnessSessionStore} backendUrl={backendUrl} appName="test" openkeyHost={backendUrl}>
      <ChatWorkspace
        tcw={shim.tcw}
        sessionStore={shim.sessionStore}
        backendUrl={backendUrl}
        selectionControllerRef={{ current: null }}
        selectionView={{ model: null, canPick: false, canSend: false, message: null } as never}
        memoryRef={{ current: null }}
        onSelectionView={() => {}}
        onSelectionAuthFailure={() => {}}
        onMemoryUpdated={() => {}}
        contextTokensFor={() => 8_000}
        settings={false}
        billingStatus={null}
      />
    </AgentAccessProvider>
  );
  const access = { covered: () => true, permitted: () => connectorsPermitted === true, request: async () => "failed" as const, confirmUse: () => {}, inFlight: null };
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/chat"]}>
        {connectorsPermitted === undefined ? chat : <HomeFeatureAccessContext.Provider value={access}>{chat}</HomeFeatureAccessContext.Provider>}
      </MemoryRouter>,
    );
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("Chat builds the meeting retriever on the plain build, and on the Home site only once Connectors is permitted", async () => {
  for (const [connectorsPermitted, built] of [[undefined, !HOME], ...(HOME ? [[false, false], [true, true]] as const : [])] as const) {
    retrieversBuilt = 0;
    const { unmount } = await mountChat(connectorsPermitted);
    try {
      expect(retrieversBuilt > 0).toBe(built);
    } finally {
      await unmount();
    }
  }
});

test("Chat shows the agent-access banner when access is available, but not on the Home site", async () => {
  const { host, unmount } = await mountChat();
  try {
    const banner = host.querySelector('[aria-label="Agent tools"]');
    expect(banner !== null).toBe(!HOME);
    expect(host.textContent?.includes("Connect agent") ?? false).toBe(!HOME);
  } finally {
    await unmount();
  }
});
