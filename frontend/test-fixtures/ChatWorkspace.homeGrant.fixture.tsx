// The REAL ChatWorkspace, by build: the Home site answers without meeting context, so it never builds the
// browser meeting retriever (which reads the connectors databases) and never shows the agent-access banner
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

async function mountChat() {
  const shim = createRuntimeShim();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const backendUrl = "http://localhost";
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/chat"]}>
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
      </MemoryRouter>,
    );
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("Chat builds the meeting retriever only on the plain build", async () => {
  const { unmount } = await mountChat();
  try {
    expect(retrieversBuilt > 0).toBe(!HOME);
  } finally {
    await unmount();
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
