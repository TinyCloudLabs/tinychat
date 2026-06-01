import { afterEach, describe, expect, mock, test } from "bun:test";

let lastTinyCloudConfig: any = null;
let lastRestoreAddress: string | undefined;
let lastCleanupCalled = false;
let lastClearPersistedSessionAddress: string | undefined;
let lastSignInOptions: any;
let restoreResult: any = { status: "restored", session: { address: "0xabc" } };
const signInSession = {
  address: "0xabc",
  walletAddress: "0xabc",
  chainId: 1,
  sessionKey: "session-key",
  siwe: "siwe-message",
  signature: "signature",
};

mock.module("@tinycloud/web-sdk", () => ({
  BrowserSessionStorage: class BrowserSessionStorage {},
  serializeDelegation: (delegation: any) => delegation.serialized ?? "serialized-delegation",
  TinyCloudWeb: class TinyCloudWeb {
    provider: unknown;

    constructor(config: any) {
      lastTinyCloudConfig = config;
    }

    async restoreSession(address?: string) {
      lastRestoreAddress = address;
      return restoreResult;
    }

    async clearPersistedSession(address?: string) {
      lastClearPersistedSessionAddress = address;
    }

    async signIn(options?: any) {
      lastSignInOptions = options;
      return signInSession;
    }

    cleanup() {
      lastCleanupCalled = true;
    }
  },
}));

const { createTinyCloudWeb, createAndSignIn, restoreTinyCloudWebSession } =
  await import("../tinycloud.js");
const { checkDelegationStatus, createManifestDelegation, revokeDelegation, sendDelegation } =
  await import("../delegation.js");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createTinyCloudWeb", () => {
  test("uses the current provider option and stores composed request manifests", () => {
    const manifests = [
      {
        manifest_version: 1,
        app_id: "com.example.app",
        name: "Example App",
        permissions: [],
      },
    ];
    const capabilityRequest = {
      manifests,
      resources: [],
      delegationTargets: [],
    };
    const provider = { request: async () => null } as any;

    const tcw = createTinyCloudWeb(provider, { capabilityRequest });

    expect(lastTinyCloudConfig.capabilityRequest).toBe(capabilityRequest);
    expect(lastTinyCloudConfig.manifest).toBe(manifests);
    expect(lastTinyCloudConfig.provider).toBe(provider);
    expect(lastTinyCloudConfig.providers).toBeUndefined();
    expect((tcw as any).provider).toBeUndefined();
  });

  test("preserves an explicit manifest over composed request manifests", () => {
    const explicitManifest = {
      manifest_version: 1,
      app_id: "com.example.explicit",
      name: "Explicit",
      permissions: [],
    };
    const capabilityRequest = {
      manifests: [
        {
          manifest_version: 1,
          app_id: "com.example.composed",
          name: "Composed",
          permissions: [],
        },
      ],
      resources: [],
      delegationTargets: [],
    };

    createTinyCloudWeb({ request: async () => null } as any, {
      manifest: explicitManifest,
      capabilityRequest,
    });

    expect(lastTinyCloudConfig.manifest).toBe(explicitManifest);
  });
});

describe("createAndSignIn", () => {
  test("forces a fresh SIWE message when a backend nonce is supplied", async () => {
    lastClearPersistedSessionAddress = undefined;
    lastSignInOptions = undefined;

    const provider = { request: async () => null } as any;
    const result = await createAndSignIn(provider, {
      address: "0xAbC",
      nonce: "fresh-backend-nonce",
      siweConfig: { statement: "Sign in to this app" },
    });

    expect(result.session).toBe(signInSession);
    expect(lastTinyCloudConfig.nonce).toBe("fresh-backend-nonce");
    expect(lastTinyCloudConfig.siweConfig).toEqual({
      statement: "Sign in to this app",
      nonce: "fresh-backend-nonce",
    });
    expect(lastClearPersistedSessionAddress).toBe("0xAbC");
    expect(lastSignInOptions).toEqual({ nonce: "fresh-backend-nonce" });
  });
});

describe("restoreTinyCloudWebSession", () => {
  test("restores a session-only TinyCloudWeb without a provider", async () => {
    restoreResult = { status: "restored", session: { address: "0xabc" } };
    lastRestoreAddress = undefined;
    lastCleanupCalled = false;

    const result = await restoreTinyCloudWebSession("0xabc", {
      tinycloudHosts: ["https://node.example"],
    });

    expect(result.status).toBe("restored");
    expect(result.tcw).not.toBeNull();
    expect(lastRestoreAddress).toBe("0xabc");
    expect(lastCleanupCalled).toBe(false);
    expect(lastTinyCloudConfig.provider).toBeUndefined();
    expect(lastTinyCloudConfig.providers).toBeUndefined();
    expect(lastTinyCloudConfig.autoCreateSpace).toBe(false);
    expect(lastTinyCloudConfig.tinycloudHosts).toEqual(["https://node.example"]);
    expect(lastTinyCloudConfig.sessionStorage.constructor.name).toBe("BrowserSessionStorage");
  });

  test("cleans up and returns backend-only state when direct restore is unavailable", async () => {
    restoreResult = { status: "missing" };
    lastRestoreAddress = undefined;
    lastCleanupCalled = false;

    const result = await restoreTinyCloudWebSession("0xabc");

    expect(result.status).toBe("missing");
    expect(result.tcw).toBeNull();
    expect(lastRestoreAddress).toBe("0xabc");
    expect(lastCleanupCalled).toBe(true);
  });
});

describe("delegation API requests", () => {
  test("serializes multi-space delegation bundles with a neutral format marker", async () => {
    const tcw = {
      delegateTo: async (_did: string, permissions: Array<{ space: string }>) => ({
        delegation: { serialized: `${permissions[0]?.space ?? "unknown"}-delegation` },
        prompted: false,
      }),
    };
    const capabilityRequest = {
      delegationTargets: [
        {
          did: "did:key:backend",
          expiryMs: Date.now() + 60_000,
          permissions: [
            {
              service: "tinycloud.kv",
              space: "applications",
              path: "com.example.app/",
              actions: ["tinycloud.kv/get"],
            },
            {
              service: "tinycloud.sql",
              space: "user",
              path: "profile",
              actions: ["tinycloud.sql/read"],
            },
          ],
        },
      ],
    };

    const result = await createManifestDelegation(
      tcw as any,
      "did:key:backend",
      capabilityRequest as any,
    );

    expect(JSON.parse(result.serialized)).toEqual({
      format: "tinycloud.delegation-bundle",
      version: 1,
      delegations: ["applications-delegation", "user-delegation"],
    });
  });

  test("sendDelegation uses the neutral CSRF request header default", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ active: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await sendDelegation("https://api.example.com", "delegation", "session-token");

    expect((capturedInit?.headers as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );
  });

  test("checkDelegationStatus uses the neutral CSRF request header default", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ active: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await checkDelegationStatus("https://api.example.com", "session-token");

    expect((capturedInit?.headers as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );
  });

  test("revokeDelegation uses the neutral CSRF request header default", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await revokeDelegation("https://api.example.com", "session-token");

    expect((capturedInit?.headers as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );
  });
});
