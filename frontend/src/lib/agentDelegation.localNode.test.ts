import { afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  clearAgentSessionCache,
  ensureAgentSession,
  mintAgentDelegation,
  mintAgentDelegationViaFreshSignIn,
  mintAgentSessionDelegations,
  mintAgentSessionViaFreshSignIn,
  mintTranscriptDelegation,
} from "./agentDelegation.js";
import { createAgentAccessController } from "../chat/useAgentEnablement.js";

const LOCAL = "http://127.0.0.1:8000";
const HOSTED = "https://tee.node.tinycloud.xyz";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAgentSessionCache();
});

/** A signer that records every delegation it is asked to make. */
function recordingTcw(host: string) {
  const asked: string[] = [];
  const tcw = {
    address: () => "0xUSER",
    chainId: () => 1,
    hosts: [host],
    space: () => ({ delegations: { create: async () => { asked.push("space.delegations.create"); return { ok: false, error: { message: "stop" } }; } } }),
    delegateTo: async () => { asked.push("delegateTo"); throw new Error("stop"); },
  } as unknown as TinyCloudWeb;
  return { tcw, asked };
}

describe("agent delegations are not made for a node on this computer", () => {
  it("memory and transcript delegations are refused before the signer is asked", async () => {
    const { tcw, asked } = recordingTcw(LOCAL);
    await expect(mintAgentDelegation(tcw)).rejects.toThrow("node on this computer");
    await expect(mintTranscriptDelegation(tcw)).rejects.toThrow("node on this computer");
    await expect(mintAgentSessionDelegations(tcw)).rejects.toThrow("node on this computer");
    expect(asked).toEqual([]);
  });

  it("an explicit local host is refused whatever the signer's own host is", async () => {
    const { tcw, asked } = recordingTcw(HOSTED);
    await expect(mintAgentDelegation(tcw, { host: LOCAL })).rejects.toThrow("node on this computer");
    expect(asked).toEqual([]);
  });

  it("the same calls reach the signer on the hosted node", async () => {
    const { tcw, asked } = recordingTcw(HOSTED);
    await expect(mintAgentDelegation(tcw)).rejects.toThrow("stop");
    await expect(mintTranscriptDelegation(tcw)).rejects.toThrow("stop");
    expect(asked).toEqual(["space.delegations.create", "delegateTo"]);
  });

  it("the fresh sign-in mints refuse before the OpenKey prompt", async () => {
    let prompted = 0;
    const options = {
      appName: "test", openkeyHost: "https://openkey.test", tinycloudHosts: [LOCAL], sessionAddress: "0xUSER",
      _connect: async () => { prompted++; throw new Error("prompted"); },
    };
    await expect(mintAgentDelegationViaFreshSignIn(options)).rejects.toThrow("node on this computer");
    await expect(mintAgentSessionViaFreshSignIn(options)).rejects.toThrow("node on this computer");
    expect(prompted).toBe(0);
  });

  it("ensureAgentSession sends nothing to the backend", async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const { tcw } = recordingTcw(LOCAL);
    await expect(ensureAgentSession({ tcw, backendUrl: "https://api.test", getToken: () => "token", force: true })).rejects.toThrow("node on this computer");
    expect(requests).toBe(0);
  });
});

describe("agent access stays off while the host is a node on this computer", () => {
  function controllerFor(host: string, mint: () => Promise<never>) {
    return createAgentAccessController({
      backendUrl: "https://api.test",
      tcw: { address: () => "0xone", hosts: [host] } as unknown as TinyCloudWeb,
      sessionStore: { getToken: () => "token" } as never,
      appName: "test",
      openkeyHost: "https://openkey.test",
      _mint: mint,
    });
  }

  it("probes nothing, mints nothing, and reports the agent as unavailable", async () => {
    let requests = 0;
    let mints = 0;
    globalThis.fetch = (async () => { requests++; return new Response(JSON.stringify({ status: "active", revision: "r1" }), { status: 200 }); }) as typeof fetch;
    const controller = controllerFor(LOCAL, async () => { mints++; throw new Error("minted"); });
    await controller.refresh();
    await controller.onEnable();
    expect(requests).toBe(0);
    expect(mints).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ capability: "unavailable", enabling: false, enableError: null });
    expect(controller.agentEnabledRef.current).toBe(false);
    controller.dispose();
  });

  it("probes the backend as before on the hosted node", async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response(JSON.stringify({ status: "none", revision: "r1" }), { status: 200 }); }) as typeof fetch;
    const controller = controllerFor(HOSTED, async () => { throw new Error("minted"); });
    await controller.refresh();
    expect(requests).toBe(1);
    expect(controller.getSnapshot().capability).toBe("available");
    controller.dispose();
  });
});
