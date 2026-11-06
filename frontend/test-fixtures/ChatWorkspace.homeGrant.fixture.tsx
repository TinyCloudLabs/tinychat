// The REAL ChatWorkspace, by build: the Home site answers without meeting context, so it never builds the
// browser meeting retriever (which reads the connectors databases); the plain build still does.
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
// Taken before the mock is installed: a module namespace is live, so reading it later returns the mock.
const realCreateRetriever = retrieverApi.createBrowserMeetingTurnRetriever;
const { AgentAccessProvider } = await import("@/chat/useAgentEnablement");
let retrieversBuilt = 0;
mock.module("@/lib/meetingChat/retriever", () => ({
  ...retrieverApi,
  createBrowserMeetingTurnRetriever: (...args: Parameters<typeof realCreateRetriever>) => {
    retrieversBuilt += 1;
    return realCreateRetriever(...args);
  },
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

test("Chat builds the meeting retriever only on the plain build", async () => {
  const shim = createRuntimeShim();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const backendUrl = "http://localhost";
  await act(async () => {
    root.render(
      <MemoryRouter>
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
  try {
    expect(retrieversBuilt > 0).toBe(!HOME);
  } finally {
    await act(async () => root.unmount());
  }
});
