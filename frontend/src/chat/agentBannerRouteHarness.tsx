// Browser harness for test/agent-banner-route.e2e.test.ts: the REAL
// AgentAccessProvider and the REAL chat-view-gated banner App mounts, under a
// real router, navigated client-side. The provider probes the harness server's
// /api/agent/session (401 → capability "available", so the Connect banner is
// eligible); tcw and the session store are the minimum the provider reads.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { AgentAccessProvider, useAgentAccess } from "./useAgentEnablement";
import { ChatViewAgentEnablementBanner } from "./AgentEnablementBanner";

declare global {
  interface Window {
    bannerHarness?: {
      navigate: (path: string) => void;
      /** Distinct AgentAccess controllers seen — 1 while the provider stays mounted. */
      controllers: () => number;
      /** Mounts of a component living beside the banner under the provider. */
      providerChildMounts: () => number;
      capability: () => string;
    };
  }
}

const tcw = { address: () => "0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
const sessionStore = { getToken: () => "harness-token" } as unknown as SessionStore;

const controllers = new Set<unknown>();
let providerChildMounts = 0;
let capability = "probing";

function Probe() {
  const navigate = useNavigate();
  const access = useAgentAccess();
  controllers.add(access.subscribe);
  capability = access.capability;
  useEffect(() => {
    providerChildMounts++;
  }, []);
  useEffect(() => {
    window.bannerHarness = {
      navigate: (path) => navigate(path),
      controllers: () => controllers.size,
      providerChildMounts: () => providerChildMounts,
      capability: () => capability,
    };
  }, [navigate]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AgentAccessProvider
      tcw={tcw}
      sessionStore={sessionStore}
      backendUrl={window.location.origin}
      appName="harness"
      openkeyHost={window.location.origin}
    >
      <Probe />
      <ChatViewAgentEnablementBanner />
    </AgentAccessProvider>
  </BrowserRouter>,
);
