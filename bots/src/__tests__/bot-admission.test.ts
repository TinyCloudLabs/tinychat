import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admissionControlKey, createAdmissionClient, createAdmissionRelay } from "../bot-admission";
import { DEFAULT_BACKEND_ORIGIN, gatewayConfig } from "../config";
import { Gateway } from "../gateway";
import { NonceGuard, signedCallHeader, verifyCall } from "../signed-call";

const secret = "secret-" + "x".repeat(64);
const controlKey = admissionControlKey(secret);
const sandboxToken = "2".repeat(64);
const owner = `did:pkh:eip155:1:0x${"11".repeat(20)}`;
const targetKey = "a".repeat(32);
const requestBody = { owner, sourceKey: "main", targetKey };
const configuredOrigin = "https://backend.example";
const signed = (body: string, key = controlKey) => signedCallHeader(key, {
  direction: "to-backend", environment: "private", owner, bot: "main", method: "POST", path: "/admit", body,
});

test("the admission endpoint is accessible only on the supervisor's authenticated control path", async () => {
  const root = mkdtempSync(join(tmpdir(), "admit-socket-"));
  const calls: { url: string; init: RequestInit }[] = [];
  const relay = createAdmissionRelay(configuredOrigin, secret, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ admitted: true, text: "upstream payload" });
  });
  const unix = join(root, "control.sock");
  const local = Bun.serve({ unix, fetch: relay });
  const gateway = new Gateway(gatewayConfig({ REDPILL_API_KEY: "test-only" }), {
    fetch: async () => { throw new Error("unexpected model fetch"); },
  });
  const botId = "1".repeat(64);
  gateway.setToken(botId, sandboxToken);
  const request = (authorization: string, path: string, body: string) => new Request(`http://gateway${path}`, {
    method: "POST", headers: { authorization, "x-target-origin": "https://elsewhere.example" }, body,
  });
  try {
    const body = JSON.stringify(requestBody);
    expect((await relay(request(`Bearer ${sandboxToken}`, "/admit", body))).status).toBe(401);
    expect((await relay(request(signed(body, sandboxToken), "/admit", body))).status).toBe(401);
    expect((await relay(request(signed(body, secret), "/admit", body))).status).toBe(401);
    expect((await relay(request(signed(body), "/admit?next=https://elsewhere.example", body))).status).toBe(404);
    expect((await relay(request(signed(body), "/wrong", body))).status).toBe(404);
    const extra = JSON.stringify({ ...requestBody, url: "https://elsewhere.example" });
    expect((await relay(request(signed(extra), "/admit", extra))).status).toBe(400);
    const forged = JSON.stringify({ ...requestBody, owner: `did:pkh:eip155:1:0x${"33".repeat(20)}` });
    expect((await relay(request(signed(forged), "/admit", forged))).status).toBe(400);
    expect((await relay(request(signed(body), "/admit", "x".repeat(513)))).status).toBe(413);
    expect((await gateway.handle(botId, request(`Bearer ${sandboxToken}`, "/admit", body))).status).toBe(403);
    expect(calls).toHaveLength(0);

    const admit = createAdmissionClient(root, controlKey);
    expect(await admit(owner, "main", targetKey)).toEqual({ admitted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${configuredOrigin}/api/internal/bots/admit`);
    expect(calls[0]!.init).toMatchObject({
      method: "POST", redirect: "error", body,
      headers: { "content-type": "application/json" },
    });
    const authorization = new Headers(calls[0]!.init.headers).get("authorization");
    const checks = { secret, direction: "to-backend", environment: "private", nonces: new NonceGuard() } as const;
    const outbound = { method: "POST", path: "/api/internal/bots/admit", body };
    expect(verifyCall(authorization, { ...outbound, path: "/admit" }, checks)).toBeNull();
    expect(verifyCall(authorization, { ...outbound, body: forged }, checks)).toBeNull();
    expect(verifyCall(authorization, outbound, { ...checks, secret: controlKey })).toBeNull();
    expect(verifyCall(authorization, outbound, checks)).toMatchObject({ owner, bot: "main" });
    expect(verifyCall(authorization, outbound, checks)).toBeNull();

    const signedOnce = signed(body);
    expect((await relay(request(signedOnce, "/admit", body))).status).toBe(200);
    expect((await relay(request(signedOnce, "/admit", body))).status).toBe(401);
  } finally {
    await local.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the configured origin is HTTPS only and every failed admission stays closed", async () => {
  const env = { REDPILL_API_KEY: "test-only" };
  expect(gatewayConfig(env).backendOrigin).toBe(DEFAULT_BACKEND_ORIGIN);
  expect(gatewayConfig({ ...env, BACKEND_ORIGIN: `${configuredOrigin}/` }).backendOrigin).toBe(configuredOrigin);
  for (const bad of ["http://backend.example", `${configuredOrigin}/path`, `${configuredOrigin}/x/..`,
    `${configuredOrigin}/?untrusted=1`, `${configuredOrigin}/#hash`, "https://user@backend.example"]) {
    expect(() => gatewayConfig({ ...env, BACKEND_ORIGIN: bad })).toThrow("BACKEND_ORIGIN must be an HTTPS origin");
  }
  const request = () => {
    const body = JSON.stringify(requestBody);
    return new Request("http://gateway/admit", { method: "POST", headers: { authorization: signed(body) }, body });
  };
  expect((await createAdmissionRelay(configuredOrigin, undefined)(request())).status).toBe(401);
  const blocked = { admitted: false, reason: "unavailable" };
  const cases = [
    () => Response.json({ admitted: true }, { status: 201 }),
    () => Response.json({ admitted: "true" }),
    () => new Response("wrong"),
    () => Response.json({ admitted: true, text: "x".repeat(513) }),
    () => { throw new DOMException("timed out", "TimeoutError"); },
  ];
  for (const respond of cases) {
    const relay = createAdmissionRelay(configuredOrigin, secret, async () => respond());
    expect(await (await relay(request())).json()).toEqual(blocked);
  }
  const denied = createAdmissionRelay(configuredOrigin, secret, async () => Response.json({ admitted: false, reason: "target_not_active" }));
  expect(await (await denied(request())).json()).toEqual({ admitted: false, reason: "target_not_active" });
});
