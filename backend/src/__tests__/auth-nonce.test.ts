import { describe, expect, it } from "bun:test";
import express from "express";
import type { Server } from "http";
import { createNonceStore } from "@tinyboilerplate/server";
import { createAuthRouter } from "../routes/auth.js";

const realFetch = globalThis.fetch;

async function request(
  app: express.Express,
  path: string,
): Promise<globalThis.Response> {
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await realFetch(`http://localhost:${port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function app() {
  const nonceStore = createNonceStore();
  const instance = express();
  instance.use(express.json());
  instance.use("/api/auth", createAuthRouter({ nonceStore, privateKey: "test-key" }));
  return { app: instance, nonceStore };
}

describe("GET /api/auth/nonce", () => {
  it("issues an unbound nonce when no address is given (native sign-in)", async () => {
    const { app: instance, nonceStore } = app();
    const res = await request(instance, "/api/auth/nonce");
    expect(res.status).toBe(200);
    const { nonce } = await res.json();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    // Unbound: the address the SIWE recovers claims it, exactly once.
    expect(nonceStore.validate("0x1111111111111111111111111111111111111111", nonce)).toBe(true);
    expect(nonceStore.validate("0x1111111111111111111111111111111111111111", nonce)).toBe(false);
  });

  it("issues a bound nonce when a valid address is given", async () => {
    const { app: instance, nonceStore } = app();
    const res = await request(
      instance,
      "/api/auth/nonce?address=0x1111111111111111111111111111111111111111",
    );
    expect(res.status).toBe(200);
    const { nonce } = await res.json();
    expect(nonceStore.validate("0x2222222222222222222222222222222222222222", nonce)).toBe(false);
    expect(nonceStore.validate("0x1111111111111111111111111111111111111111", nonce)).toBe(true);
  });

  it("rejects a malformed address", async () => {
    const { app: instance } = app();
    const res = await request(instance, "/api/auth/nonce?address=not-an-address");
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe("invalid_address");
  });
});
