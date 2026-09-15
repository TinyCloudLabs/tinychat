import { expect, test } from "bun:test";
import { resolveLocalValidation } from "./localValidation";
import * as validation from "./localValidation";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

test("local validation defaults off and requires explicit DEV on loopback", () => {
  expect(resolveLocalValidation({}, "tinycloud.chat")).toBe(false);
  expect(resolveLocalValidation({ VITE_LOCAL_VALIDATION: "false" }, "tinycloud.chat")).toBe(false);
  for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    expect(resolveLocalValidation({ VITE_LOCAL_VALIDATION: "true", DEV: true }, hostname)).toBe(true);
  }
  for (const hostname of [undefined, "tinycloud.chat", "localhost.example", "0.0.0.0"]) {
    expect(() => resolveLocalValidation({ VITE_LOCAL_VALIDATION: "true", DEV: true }, hostname)).toThrow("loopback");
  }
  expect(() => resolveLocalValidation({ VITE_LOCAL_VALIDATION: "true", DEV: false }, "localhost")).toThrow("DEV");
  expect(() => resolveLocalValidation({ VITE_LOCAL_VALIDATION: "yes", DEV: true }, "localhost")).toThrow("true or false");
});

test("local validation cannot send billing or session requests to a remote backend", () => {
  for (const VITE_BACKEND_URL of ["https://api.tinycloud.chat", "not-a-url", "file://localhost/tmp"]) {
    expect(() => resolveLocalValidation({ VITE_LOCAL_VALIDATION: "true", DEV: true, VITE_BACKEND_URL }, "localhost")).toThrow("loopback HTTP backend");
  }
  expect(resolveLocalValidation({ VITE_LOCAL_VALIDATION: "true", DEV: true, VITE_BACKEND_URL: "http://localhost:3014" }, "localhost")).toBe(true);
});

test("local sign-in keeps session activation and suppresses automatic account/encryption writes", async () => {
  expect(typeof validation.prepareLocalSignIn).toBe("function");
  const writes: string[] = [];
  let activations = 0;
  const node = {
    bootstrapAccountIfNeeded: async () => { writes.push("bootstrap"); return false; },
    ensureRequestedEncryptionNetworks: async () => { writes.push("encryption"); },
    scheduleAccountRegistrySync: () => { writes.push("registry"); },
    ensureOwnedSpaceHostedById: async () => { writes.push("hosting"); },
    async signIn() {
      activations++;
      await this.bootstrapAccountIfNeeded();
      await this.ensureRequestedEncryptionNetworks();
      this.scheduleAccountRegistrySync();
    },
  };
  const tcw = { ensureNode: async () => node } as unknown as TinyCloudWeb;
  await validation.prepareLocalSignIn(tcw);
  await node.signIn();
  expect(activations).toBe(1);
  expect(writes).toEqual([]);
  await expect(node.ensureOwnedSpaceHostedById()).rejects.toThrow("Local validation cannot host a space");
  await expect(validation.prepareLocalSignIn({ ensureNode: async () => ({}) } as unknown as TinyCloudWeb)).rejects.toThrow("SDK local validation hook unavailable");
});
