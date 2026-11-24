import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import cors from "cors";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  appCorsOptions,
  DEFAULT_FRONTEND_ORIGINS,
  EXO_ANDROID_ORIGIN,
  EXO_DESKTOP_ORIGIN,
  EXO_DESKTOP_WINDOWS_ORIGIN,
  EXO_IOS_ORIGIN,
  frontendOriginsFromEnv,
  HOME_WEB_ORIGIN,
  LOCAL_WEB_ORIGINS,
  TINYCHAT_WEB_ORIGIN,
  TINYCLOUD_ONE_WEB_ORIGIN,
} from "../cors-origins.js";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import { createNonceStore } from "@tinyboilerplate/server";
import { createAuthRouter } from "../routes/auth.js";


const WEB_ORIGIN = "https://tinycloud.chat";
const SAM_TAILNET_DEV_ORIGIN = "https://lightning-node-1.gecko-snares.ts.net:5240";


let server: Server;
let baseUrl: string;

async function listen(origins: readonly string[]): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(cors(appCorsOptions(origins)));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  return { server: listener, baseUrl: `http://127.0.0.1:${(listener.address() as AddressInfo).port}` };
}

async function close(listener: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
}

beforeAll(async () => {
  ({ server, baseUrl } = await listen(frontendOriginsFromEnv(WEB_ORIGIN, {})));
});

afterAll(async () => {
  await close(server);
});

describe("frontend origin allowlist", () => {
  test("defaults to every production web origin plus FRONTEND_URL", () => {
    expect(DEFAULT_FRONTEND_ORIGINS).toEqual([TINYCHAT_WEB_ORIGIN, HOME_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN]);
    expect(frontendOriginsFromEnv("https://tinycloud.chat", {})).toEqual([TINYCHAT_WEB_ORIGIN, HOME_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN]);
    expect(frontendOriginsFromEnv("https://home.tinycloud.xyz/", {})).toEqual([HOME_WEB_ORIGIN, TINYCHAT_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN]);
    expect(frontendOriginsFromEnv("http://localhost:5186", { FRONTEND_ORIGINS: " " }))
      .toEqual(["http://localhost:5186", TINYCHAT_WEB_ORIGIN, HOME_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN]);
  });

  test("an explicit list replaces the default and always keeps FRONTEND_URL", () => {
    expect(frontendOriginsFromEnv("https://home.tinycloud.xyz", { FRONTEND_ORIGINS: "HTTPS://Staging.Example:443, http://127.0.0.1:8080/" }))
      .toEqual([HOME_WEB_ORIGIN, "https://staging.example", "http://127.0.0.1:8080"]);
  });

  test.each(["*", "tinycloud.chat", "https://tinycloud.chat/path", "https://tinycloud.chat/?x", "https://user:pw@tinycloud.chat", "ftp://tinycloud.chat", "https://tinycloud.chat,"])(
    "refuses FRONTEND_ORIGINS=%s",
    (value) => {
      expect(() => frontendOriginsFromEnv(WEB_ORIGIN, { FRONTEND_ORIGINS: value })).toThrow(
        "FRONTEND_ORIGINS must contain only comma-separated HTTP(S) origins",
      );
    },
  );

  test.each(["*", "tinycloud.chat", "ftp://tinycloud.chat"])("refuses FRONTEND_URL=%s", (value) => {
    expect(() => frontendOriginsFromEnv(value, {})).toThrow("FRONTEND_URL must be an HTTP(S) URL");
  });
});

describe("SIWE domain extraction with URL.host (auth router)", () => {
  const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
  const KEY = "test-siwe-domain-key";
  const csrfHeader = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };

  async function createTestAuthServer(frontendUrl: string, explicitOrigins?: string[]) {
    const nonceStore = createNonceStore();
    const app = express();
    app.use(express.json());
    const frontendOrigins = explicitOrigins ?? frontendOriginsFromEnv(frontendUrl, {});
    app.use("/api/auth", createAuthRouter({ nonceStore, privateKey: KEY, frontendOrigins }));
    const listener = app.listen(0, "127.0.0.1");
    const { promise, resolve } = Promise.withResolvers<void>();
    listener.once("listening", resolve);
    await promise;
    const port = (listener.address() as AddressInfo).port;
    return { server: listener, baseUrl: `http://127.0.0.1:${port}`, nonceStore };
  }

  async function signMessage(nonce: string, domain: string, uri: string) {
    const message = createSiweMessage({
      domain,
      address: account.address,
      statement: "Sign in",
      uri,
      version: "1",
      chainId: 1,
      nonce,
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });
    return { message, signature };
  }

  async function postVerify(baseUrl: string, message: string, signature: string) {
    const response = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: csrfHeader,
      body: JSON.stringify({ message, signature }),
    });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }

  test("existing default origins accept their exact hostnames as SIWE domains", async () => {
    const cases: Array<{ frontendUrl: string; domain: string; uri: string }> = [
      { frontendUrl: TINYCHAT_WEB_ORIGIN, domain: "tinycloud.chat", uri: "https://tinycloud.chat" },
      { frontendUrl: HOME_WEB_ORIGIN, domain: "home.tinycloud.xyz", uri: "https://home.tinycloud.xyz" },
      { frontendUrl: TINYCLOUD_ONE_WEB_ORIGIN, domain: "tinycloud.one", uri: "https://tinycloud.one" },
    ];

    for (const { frontendUrl, domain, uri } of cases) {
      const { server: authServer, baseUrl, nonceStore } = await createTestAuthServer(frontendUrl);
      try {
        const nonce = nonceStore.generate(account.address);
        const signed = await signMessage(nonce, domain, uri);
        const result = await postVerify(baseUrl, signed.message, signed.signature);
        expect(result.status).toBe(200);
        expect(result.body).toHaveProperty("token");
      } finally {
        const { promise, resolve } = Promise.withResolvers<void>();
        authServer.close(() => resolve());
        await promise;
      }
    }
  });

  test("Sam's tailnet dev origin accepts host:port as SIWE domain", async () => {
    const { server: authServer, baseUrl, nonceStore } = await createTestAuthServer(SAM_TAILNET_DEV_ORIGIN, [SAM_TAILNET_DEV_ORIGIN]);
    try {
      const nonce = nonceStore.generate(account.address);
      const signed = await signMessage(nonce, "lightning-node-1.gecko-snares.ts.net:5240", "https://lightning-node-1.gecko-snares.ts.net:5240");
      const result = await postVerify(baseUrl, signed.message, signed.signature);
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("token");
    } finally {
      const { promise, resolve } = Promise.withResolvers<void>();
      authServer.close(() => resolve());
      await promise;
    }
  });

  test("Sam's tailnet dev origin refuses bare hostname without port", async () => {
    const { server: authServer, baseUrl, nonceStore } = await createTestAuthServer(SAM_TAILNET_DEV_ORIGIN, [SAM_TAILNET_DEV_ORIGIN]);
    try {
      const nonce = nonceStore.generate(account.address);
      const signed = await signMessage(nonce, "lightning-node-1.gecko-snares.ts.net", "https://lightning-node-1.gecko-snares.ts.net");
      const result = await postVerify(baseUrl, signed.message, signed.signature);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: "invalid_origin",
        message: "SIWE domain or URI does not match this application",
      });
    } finally {
      const { promise, resolve } = Promise.withResolvers<void>();
      authServer.close(() => resolve());
      await promise;
    }
  });

  test("Sam's tailnet dev origin refuses different port", async () => {
    const { server: authServer, baseUrl, nonceStore } = await createTestAuthServer(SAM_TAILNET_DEV_ORIGIN, [SAM_TAILNET_DEV_ORIGIN]);
    try {
      const nonce = nonceStore.generate(account.address);
      const signed = await signMessage(nonce, "lightning-node-1.gecko-snares.ts.net:5241", "https://lightning-node-1.gecko-snares.ts.net:5241");
      const result = await postVerify(baseUrl, signed.message, signed.signature);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: "invalid_origin",
        message: "SIWE domain or URI does not match this application",
      });
    } finally {
      const { promise, resolve } = Promise.withResolvers<void>();
      authServer.close(() => resolve());
      await promise;
    }
  });
});

describe.each([WEB_ORIGIN, HOME_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN])("CORS with FRONTEND_URL=%s and the default allowlist", (frontendUrl) => {
  let origins: { server: Server; baseUrl: string };
  beforeAll(async () => {
    origins = await listen(frontendOriginsFromEnv(frontendUrl, {}));
  });
  afterAll(async () => {
    await close(origins.server);
  });

  test.each([TINYCHAT_WEB_ORIGIN, HOME_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN])("allows the preflight from %s", async (origin) => {
    const response = await fetch(`${origins.baseUrl}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,x-requested-with",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test.each(["https://attacker.example", "https://tinycloud.chat.evil.example", "http://tinycloud.chat", "https://tinycloud.one.evil.example", "http://tinycloud.one"])(
    "refuses the preflight from %s",
    async (origin) => {
      const response = await fetch(`${origins.baseUrl}/health`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    },
  );
});

test("an explicit allowlist without tinycloud.chat refuses it", async () => {
  const narrow = await listen(frontendOriginsFromEnv(HOME_WEB_ORIGIN, { FRONTEND_ORIGINS: HOME_WEB_ORIGIN }));
  try {
    const response = await fetch(`${narrow.baseUrl}/health`, { headers: { Origin: TINYCHAT_WEB_ORIGIN } });
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  } finally {
    await close(narrow.server);
  }
});

describe("app CORS origins", () => {
  test.each([WEB_ORIGIN, HOME_WEB_ORIGIN, EXO_DESKTOP_ORIGIN, EXO_DESKTOP_WINDOWS_ORIGIN, EXO_ANDROID_ORIGIN, EXO_IOS_ORIGIN])(
    "allows %s",
    async (origin) => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: origin },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    },
  );

  test.each([
    "https://feat-conversation-canvas.tinychat-4jq.pages.dev",
    "https://aa9b9056.tinychat-4jq.pages.dev",
    ...LOCAL_WEB_ORIGINS,
  ])("allows the controlled testing origin %s", async (origin) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test.each([
    "https://attacker.example",
    "https://tinychat-4jq.pages.dev.attacker.example",
    "https://other-project.pages.dev",
    "http://localhost:5173",
    "https://localhost:8443",
    "capacitor://attacker.example",
    "https://home.tinycloud.xyz.evil.example",
    "https://evilhome.tinycloud.xyz",
    "http://home.tinycloud.xyz",
    "https://home.tinycloud.xyz:8443",
    "https://home.tinycloud.xyz.",
    "https://www.tinycloud.one",
    "https://evil-tinycloud.one",
    "https://tinycloud.one.evil.example",
    "http://tinycloud.one",
    "https://tinycloud.one:8443",
    "https://tinycloud.one.",
    "https://lightning-node-1.gecko-snares.ts.net",
    "https://lightning-node-1.gecko-snares.ts.net:5241",
  ])("does not allow unrelated origin %s", async (origin) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  test("allows the desktop verify preflight and its CSRF header", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: EXO_DESKTOP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-requested-with",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      EXO_DESKTOP_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "x-requested-with",
    );
  });

  test.each([WEB_ORIGIN, HOME_WEB_ORIGIN, EXO_DESKTOP_ORIGIN, EXO_DESKTOP_WINDOWS_ORIGIN])(
    "allows the hosted AssemblyAI part preflight from %s",
    async (origin) => {
      const response = await fetch(`${baseUrl}/health`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "authorization,x-requested-with,content-type",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
      expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    },
  );
});
