import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const owner = `did:pkh:eip155:1:0x${"11".repeat(20)}`;
const secret = "courier-server-test-" + "x".repeat(64);
const dirs: string[] = [];
const servers: Server<undefined>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function request(path: string, method = "GET", body?: unknown, bot = "main") {
  const url = `http://bots/v1/bots/${bot}/courier/${path}`;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Request(url, { method, ...(serialized === undefined ? {} : { body: serialized }), headers: { authorization: signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot, method, path: new URL(url).pathname, body: serialized }) } });
}

async function setup(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "courier-server-")); dirs.push(dir);
  const socket = join(dir, "control.sock");
  const seen: { method: string; path: string; body: unknown }[] = [];
  servers.push(Bun.serve({ unix: socket, async fetch(req) {
    seen.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json().catch(() => undefined) });
    return req.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ did: "did:key:zTest" });
  } }));
  const app = createApp({ secret, accounts: new Set(["0x" + "11".repeat(20)]), acceptLegacyOwnerHeader: true,
    courierControlSocket: enabled ? socket : undefined,
    bots: { forOwner() { throw new Error("Courier settings must not start a sandbox"); } },
  });
  return { app, seen };
}

test("signed identity and grant calls relay only the authenticated owner to the gateway", async () => {
  const { app, seen } = await setup();
  expect((await app(request("identity"))).status).toBe(200);
  const grant = { raw: { proof: "signed" }, expiresAt: Date.now() + 1000, owner: "attacker" };
  expect((await app(request("grant", "PUT", grant))).status).toBe(200);
  expect((await app(request("grant", "DELETE"))).status).toBe(204);
  expect(seen.map(item => item.path)).toEqual(["identity", "grant", "grant"].map(resource => `/courier/${encodeURIComponent(owner)}/${resource}`));
  expect(seen[1]?.body).toEqual(grant);
});

test("pairing and transcript routes use the same signed main-only relay", async () => {
  const { app, seen } = await setup();
  expect((await app(request("peers"))).status).toBe(200);
  expect((await app(request("threads/thread-1"))).status).toBe(200);
  expect((await app(request("peers", "GET", undefined, "a".repeat(32)))).status).toBe(404);
  expect(seen).toHaveLength(2);
});

test("Courier stays dark without the configured relay and rejects legacy owner headers", async () => {
  const disabled = await setup(false);
  expect((await disabled.app(request("identity"))).status).toBe(404);
  const { app, seen } = await setup();
  const req = new Request("http://bots/v1/bots/main/courier/identity", { headers: { authorization: `Bearer ${secret}`, "x-tinycloud-owner": owner } });
  expect((await app(req)).status).toBe(401);
  expect(seen).toHaveLength(0);
});
