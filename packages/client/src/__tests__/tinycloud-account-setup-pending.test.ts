import { describe, expect, mock, test } from "bun:test";

// web-sdk 3.18.0 `account.setup.pending`: the host's handler is subscribed on every sign-in client this package constructs,
// which also keeps the SDK's own setup toast from showing. A restore never sets an account up, so it never subscribes.
const subscriptions: Array<{ client: object; event: string; handler: (event: unknown) => void }> = [];

mock.module("@tinycloud/web-sdk", () => ({
  serializeDelegation: () => "serialized-delegation",
  BrowserSessionStorage: class BrowserSessionStorage {
    async load() {
      return null;
    }
  },
  TinyCloudWeb: class TinyCloudWeb {
    on(event: string, handler: (event: unknown) => void) {
      subscriptions.push({ client: this, event, handler });
      return () => undefined;
    }
    cleanup() {}
    get spaceId() {
      return "space";
    }
    async restoreSession() {
      return { status: "restored", session: { address: "0xabc" } };
    }
  },
}));

const { createTinyCloudWeb, restoreTinyCloudWebSession } = await import("../tinycloud.js?account-setup-pending");

describe("account.setup.pending subscription", () => {
  test("the host handler is called with the client the SDK reported for", () => {
    subscriptions.length = 0;
    const seen: object[] = [];
    const client = createTinyCloudWeb({} as any, { onAccountSetupPending: (c) => { seen.push(c); } });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.event).toBe("account.setup.pending");
    subscriptions[0]!.handler({ address: "0xabc", finishSetup: async () => true });
    expect(seen).toEqual([client]);
  });

  test("without a handler nothing is subscribed, so the SDK keeps its own toast", () => {
    subscriptions.length = 0;
    createTinyCloudWeb({} as any);
    expect(subscriptions).toHaveLength(0);
  });

  test("a restore never subscribes", async () => {
    subscriptions.length = 0;
    await restoreTinyCloudWebSession("0xabc", { onAccountSetupPending: () => undefined } as any);
    expect(subscriptions).toHaveLength(0);
  });
});
