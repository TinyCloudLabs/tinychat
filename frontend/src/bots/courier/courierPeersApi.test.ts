import { afterEach, expect, spyOn, test, type Mock } from "bun:test";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import { installDom } from "@/test/dom";
import { BotsError, BotsRouteMissing } from "../botsApi";
import { courierPeersApi, CourierUpdateRequired } from "./courierPeersApi";

const PEER = { handle: "agent/a", peerDid: "did:key:peer", status: "paired", pairedAt: 123, delegationExpiresAt: 456 };
const PENDING = { acceptArtifact: "accept-code", pending: true, handle: "agent/a", pendingExpiresAt: 999 };
let restore: (() => void) | undefined;
let fetchSpy: Mock<typeof fetch> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; restore?.(); restore = undefined; });
function setup(body: unknown = { peers: [PEER] }) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
}

test("GET peers authenticates with the session and standard client header", async () => {
  setup();
  expect(await courierPeersApi.listPeers()).toEqual({ peers: [PEER] });
  const [url, init] = fetchSpy!.mock.calls[0] as [string, RequestInit];
  expect(url.endsWith("/api/bots/main/courier/peers")).toBe(true);
  expect(init.method).toBe("GET");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-token");
  expect((init.headers as Record<string, string>)[DEFAULT_REQUEST_HEADER_NAME]).toBe(DEFAULT_REQUEST_HEADER_VALUE);
  expect(init.cache).toBe("no-store");
  expect(init.body).toBeUndefined();
});

test("POST sends only the artifact for both pending and completed pairing", async () => {
  setup(PENDING);
  expect(await courierPeersApi.pairPeer({ artifact: "start-code" })).toEqual(PENDING);
  fetchSpy!.mockResolvedValue(Response.json({ peer: PEER }));
  expect(await courierPeersApi.pairPeer({ artifact: "final-code" })).toEqual({ peer: PEER });
  const calls = fetchSpy!.mock.calls as [string, RequestInit][];
  expect(calls.map(([, init]) => JSON.parse(init.body as string))).toEqual([{ artifact: "start-code" }, { artifact: "final-code" }]);
  for (const [url, init] of calls) {
    expect(url.endsWith("/api/bots/main/courier/peers")).toBe(true);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-token");
  }
});

test("DELETE encodes the handle and accepts an empty 204 response", async () => {
  setup();
  fetchSpy!.mockResolvedValue(new Response(null, { status: 204 }));
  expect(await courierPeersApi.unpairPeer(PEER.handle)).toBeUndefined();
  const [url, init] = fetchSpy!.mock.calls[0] as [string, RequestInit];
  expect(url.endsWith("/api/bots/main/courier/peers/agent%2Fa")).toBe(true);
  expect(init.method).toBe("DELETE");
  expect(init.body).toBeUndefined();
});

test("404 is represented as the shared missing-route error", async () => {
  setup();
  fetchSpy!.mockResolvedValue(new Response(null, { status: 404 }));
  await expect(courierPeersApi.listPeers()).rejects.toBeInstanceOf(BotsRouteMissing);
});

test("signed-out sessions send no request", async () => {
  restore = installDom({});
  fetchSpy = spyOn(globalThis, "fetch");
  await expect(courierPeersApi.listPeers()).rejects.toMatchObject({ code: "signed_out" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("malformed responses fail instead of rendering invalid peer records", async () => {
  setup({ peers: [{ ...PEER, status: "pending" }] });
  await expect(courierPeersApi.listPeers()).rejects.toBeInstanceOf(BotsError);
  fetchSpy!.mockResolvedValue(Response.json({ ...PENDING, pendingExpiresAt: "invalid" }));
  await expect(courierPeersApi.pairPeer({ artifact: "start-code" })).rejects.toBeInstanceOf(BotsError);
});

test("network and server errors expose only the shared failed code", async () => {
  setup();
  fetchSpy!.mockRejectedValue(new Error("fixture"));
  await expect(courierPeersApi.listPeers()).rejects.toMatchObject({ code: "failed" });
  fetchSpy!.mockResolvedValue(new Response(null, { status: 500 }));
  await expect(courierPeersApi.listPeers()).rejects.toMatchObject({ code: "failed" });
});

test("expired peer status is accepted from the server", async () => {
  const peer = { ...PEER, status: "expired" };
  setup({ peers: [peer] });
  expect(await courierPeersApi.listPeers()).toEqual({ peers: [peer] });
});

test("HTTP 426 becomes a fixed update-required error without exposing SDK details", async () => {
  setup();
  fetchSpy!.mockResolvedValue(Response.json({ error: "courier_update_required", detail: "private fixture detail" }, { status: 426 }));
  await expect(courierPeersApi.pairPeer({ artifact: "start-code" })).rejects.toBeInstanceOf(CourierUpdateRequired);
  fetchSpy!.mockResolvedValue(Response.json({ error: "courier_update_required" }, { status: 426 }));
  await expect(courierPeersApi.pairPeer({ artifact: "start-code" })).rejects.toMatchObject({ message: "Bots request failed: failed" });
});
