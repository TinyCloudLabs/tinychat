import { describe, expect, it } from "bun:test";

import { createAgentAccessController } from "./useAgentEnablement";

describe("Disconnect while signed out", () => {
  it("says the account is signed out instead of the generic retry line, and never shows Disconnected", async () => {
    let fetched = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => { fetched++; return new Response(null, { status: 500 }); }) as typeof fetch;
    try {
      const c = createAgentAccessController({
        backendUrl: "https://api.test",
        tcw: { address: () => "0xone" } as never,
        sessionStore: { getToken: () => null } as never,
        appName: "test", openkeyHost: "https://openkey.test",
      });
      await c.onDisconnect();
      expect(c.getSnapshot().status).toBe(null);
      expect(c.getSnapshot().enableError).toBe("You're signed out, so we couldn't confirm the disconnect. Sign in and try again.");
      expect(fetched).toBe(0);
      c.dispose();
    } finally {
      globalThis.fetch = previous;
    }
  });
});
