import { afterEach, describe, expect, it, vi } from "bun:test";
import { createAgentAccessController } from "./useAgentEnablement.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("agent access probe schedule after one failure", () => {
  it("retries once after 10 s and returns to the 60 s poll when that retry succeeds", async () => {
    vi.useFakeTimers();
    const names = ["window", "document", "BroadcastChannel"];
    const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const browserWindow = new EventTarget() as EventTarget & { navigator: { onLine: boolean }; setTimeout: Window["setTimeout"]; localStorage: Pick<Storage, "setItem"> };
    browserWindow.navigator = { onLine: true };
    browserWindow.localStorage = { setItem() {} };
    browserWindow.setTimeout = ((handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler as () => void, timeout)) as Window["setTimeout"];
    const browserDocument = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    browserDocument.visibilityState = "visible";
    Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: browserDocument });
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });

    let probes = 0;
    globalThis.fetch = (async () => {
      probes++;
      return probes === 1 ? new Response(null, { status: 502 }) : Response.json({ status: "active", transcriptStatus: "active", revision: "r1" });
    }) as typeof fetch;
    const c = createAgentAccessController({
      backendUrl: "https://api.test", tcw: { address: () => "0xone" } as never,
      sessionStore: { getToken: () => "token" } as never,
      appName: "test", openkeyHost: "https://openkey.test",
    });
    const unlisten = c.listen();
    try {
      await c.refresh();
      expect(probes).toBe(1);
      expect(c.getSnapshot().probeFailed).toBe(true);

      vi.advanceTimersByTime(9_999);
      expect(probes).toBe(1);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(2);
      expect(c.getSnapshot().capability).toBe("enabled");

      vi.advanceTimersByTime(59_999);
      expect(probes).toBe(2);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(3);
    } finally {
      unlisten();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
