// The REAL ChatWorkspace (over the in-memory runtime shim, no network) must mount the first-load
// signal: once its chat list has loaded, the replication fill's default signal resolves. Without the
// mount the fill would silently wait for its deadline in the app while every stub-signal test passes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { createRuntimeShim } from "@/harness/runtimeShim";
import { harnessSessionStore, harnessTcw } from "@/harness/stubs";
import { AgentAccessProvider } from "@/chat/useAgentEnablement";
import { appFirstLoadSettled, resetAppFirstLoad } from "@/lib/replication/replicationFirstLoad";

// The web SDK reads DOM globals when it loads, so the workspace is imported under an installed DOM.
const restoreImportDom = installDom();
const { ChatWorkspace } = await import("./ChatWorkspace");
restoreImportDom();

let restoreDom: () => void;
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  restoreDom = installDom();
  Object.assign(globalThis, { ResizeObserver: NoopObserver });
});
afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  restoreDom();
});

test("mounting ChatWorkspace settles the app's first-load signal", async () => {
  resetAppFirstLoad();
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
  let settled = false;
  void appFirstLoadSettled().then(() => { settled = true; });
  for (let turn = 0; turn < 300 && !settled; turn += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  try {
    expect(settled).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
