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

const WEB_ORIGIN = "https://tinycloud.chat";

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
