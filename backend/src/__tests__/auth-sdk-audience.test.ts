import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { Window } from "happy-dom";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import { makeSpaceId, prepareSession, TCWSessionManager } from "@tinycloud/node-sdk-wasm";
import { createNonceStore } from "@tinyboilerplate/server";
import type { Manifest } from "@tinycloud/sdk-core";
import type { TinyCloudWeb as TinyCloudWebClass } from "@tinycloud/web-sdk";
import APP_MANIFEST from "../../../manifest.json";
import { nativePermissions } from "../../../frontend/src/lib/openkeyNative.js";
import { createAuthRouter } from "../routes/auth.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const SESSION_URI = /^did:key:(z6Mk[1-9A-HJ-NP-Za-km-z]{44})#\1$/;
const globals = ["window", "document", "navigator", "HTMLElement", "customElements", "localStorage"] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let browser: Window;
let TinyCloudWeb: typeof TinyCloudWebClass;

beforeAll(async () => {
  browser = new Window({ url: "https://tinycloud.chat/" });
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "window" ? browser : browser[name],
    });
  }
  // web-sdk defines browser custom elements at import time; install the test DOM first.
  ({ TinyCloudWeb } = await import("@tinycloud/web-sdk"));
});

afterAll(async () => {
  for (const name of globals) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.abort();
});

async function startAuthServer() {
  const nonceStore = createNonceStore();
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({
    nonceStore, privateKey: "isolated-sdk-audience-test-key", frontendUrl: "https://tinycloud.chat",
  }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    async nonce(bound = true): Promise<string> {
      const query = bound ? `?address=${account.address}` : "";
      const response = await fetch(`${base}/api/auth/nonce${query}`);
      if (!response.ok) throw new Error(`Nonce HTTP ${response.status}`);
      const body = await response.json() as { nonce: string };
      return body.nonce;
    },
    async verify(message: string, signature: string) {
      const response = await fetch(`${base}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      const body = await response.json() as { error?: string };
      return { status: response.status, error: body.error ?? null };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Capture the exact SIWE bytes the installed browser SDK sends to EIP-1193 personal_sign.
 * Stop there so this test never needs a live OpenKey key or TinyCloud node. */
async function signWithWebSdk(origin: string, nonce: string, claimedDomain?: string) {
  browser.happyDOM.setURL(origin);
  const captured = { message: "", signature: "" };
  const signed = Symbol("signed by offline wallet");
  const provider = {
    request: async ({ method, params }: { method: string; params?: string[] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        const hex = params?.[0];
        if (!hex?.startsWith("0x")) throw new Error("Expected EIP-1193 message bytes");
        captured.message = Buffer.from(hex.slice(2), "hex").toString("utf8");
        captured.signature = await account.signMessage({ message: captured.message });
        throw signed;
      }
      throw new Error(`Unexpected wallet method ${method}`);
    },
  };
  const tcw = new TinyCloudWeb({
    provider,
    tinycloudHosts: ["http://127.0.0.1:9"],
    autoCreateSpace: true,
    autoBootstrapAccount: false,
    persistSession: false,
    nonce,
    siweConfig: { nonce },
    manifest: APP_MANIFEST as Manifest,
    ...(claimedDomain ? { domain: claimedDomain } : {}),
  });
  try {
    await tcw.signIn({ nonce });
  } catch (error) {
    if (error !== signed) throw error;
  }
  if (!captured.message || !captured.signature) throw new Error("SDK did not request a signature");
  return captured;
}

/** OpenKey native consent uses the same WASM session builder with the actual
 * permissions requested by Exo's iOS/Android client. */
function signWithNativeBuilder(nonce: string) {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of nativePermissions(APP_MANIFEST as Manifest)) {
    if (permission.space !== "applications") throw new Error("Unexpected native permission space");
    const service = permission.service.replace(/^tinycloud\./, "");
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const manager = new TCWSessionManager();
  manager.createSessionKey("native-test");
  const jwk = JSON.parse(manager.jwk("native-test")!);
  const issuedAt = new Date();
  const prepared = prepareSession({
    address: account.address,
    chainId: 1,
    domain: "openkey.so",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60_000).toISOString(),
    spaceId: makeSpaceId(account.address, 1, "applications"),
    jwk,
    nonce,
    abilities,
  });
  manager.free();
  return prepared.siwe as string;
}

describe("real SDK SIWE audience", () => {
  for (const [name, origin, domain] of [
    ["production web", "https://tinycloud.chat/chat", "tinycloud.chat"],
    ["Pages preview", "https://feature-12.tinychat-4jq.pages.dev/chat", "feature-12.tinychat-4jq.pages.dev"],
    ["macOS Tauri", "tauri://localhost/chat", "localhost"],
    ["Windows Tauri", "http://tauri.localhost/chat", "tauri.localhost"],
  ]) {
    test(`accepts ${name}'s SDK-generated session DID`, async () => {
      const server = await startAuthServer();
      try {
        const nonce = await server.nonce();
        const signed = await signWithWebSdk(origin, nonce);
        const parsed = parseSiweMessage(signed.message);
        expect(parsed.domain).toBe(domain);
        expect(parsed.uri).toMatch(SESSION_URI);
        expect(parsed.nonce).toBe(nonce);
        expect(await server.verify(signed.message, signed.signature)).toEqual({ status: 200, error: null });
      } finally {
        await server.close();
      }
    });
  }

  test("accepts iOS/Android native OpenKey's SDK-generated delegation, not a web URI", async () => {
    const server = await startAuthServer();
    try {
      const nonce = await server.nonce(false);
      const message = signWithNativeBuilder(nonce);
      const parsed = parseSiweMessage(message);
      expect(parsed.domain).toBe("openkey.so");
      expect(parsed.uri).toMatch(SESSION_URI);
      expect(await server.verify(message, await account.signMessage({ message }))).toEqual({ status: 200, error: null });
      const wrongUri = createSiweMessage({
        domain: "openkey.so", address: account.address, statement: "Sign in", uri: "https://openkey.so",
        version: "1", chainId: 1, nonce: await server.nonce(false), issuedAt: new Date(),
        resources: parsed.resources,
      });
      expect(await server.verify(wrongUri, await account.signMessage({ message: wrongUri }))).toEqual({
        status: 400, error: "invalid_origin",
      });
    } finally {
      await server.close();
    }
  });

  test("never treats a web SDK grant claiming the OpenKey domain as a native grant", async () => {
    const server = await startAuthServer();
    try {
      const nonce = await server.nonce(false);
      const signed = await signWithWebSdk("https://attacker.example/chat", nonce, "openkey.so");
      const parsed = parseSiweMessage(signed.message);
      expect(parsed.domain).toBe("openkey.so");
      expect(parsed.uri).toMatch(SESSION_URI);
      expect(await server.verify(signed.message, signed.signature)).toEqual({
        status: 400, error: "invalid_native_audience",
      });
    } finally {
      await server.close();
    }
  });

  test("rejects an attacker host with a canonical SDK session DID", async () => {
    const server = await startAuthServer();
    try {
      const nonce = await server.nonce();
      const signed = await signWithWebSdk("https://evil.pages.dev/chat", nonce);
      expect(await server.verify(signed.message, signed.signature)).toEqual({ status: 400, error: "invalid_origin" });
    } finally {
      await server.close();
    }
  });
});
