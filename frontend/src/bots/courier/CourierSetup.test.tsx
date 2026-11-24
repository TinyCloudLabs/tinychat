import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsRouteMissing } from "../botsApi";
import { CourierSetup, courierApprovalUrl, parseCourierGrant, type CourierIdentity, type CourierSetupApi } from "./CourierSetup";

const OWNER = "0x" + "11".repeat(20);
const IDENTITY: CourierIdentity = {
  did: "did:key:zCourier",
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "public-key" },
  request: {
    host: "https://node.tinycloud.xyz",
    expiry: "30d",
    permissions: [{ service: "tinycloud.kv", space: "agents", path: "xyz.tinycloud.courier/to/", actions: ["tinycloud.kv/get"] }],
  },
};
const NOW = Date.UTC(2026, 10, 23, 12);
const UNTIL = NOW + 30 * 86_400_000;
const rawGrant = () => ({
  delegationHeader: { Authorization: "signed-capability" },
  delegationCid: "signed-cid",
  spaceId: `tinycloud:pkh:eip155:1:${OWNER}:agents`,
  address: OWNER,
  chainId: 1,
  siwe: `Issued At: ${new Date(NOW).toISOString()}\nExpiration Time: ${new Date(UNTIL).toISOString()}`,
  signature: "owner-signature",
  verificationMethod: `${IDENTITY.did}#zCourier`,
  jwk: IDENTITY.publicJwk,
});

test("the OpenKey request preserves the server's exact Courier manifest and public TEE identity", () => {
  const url = new URL(courierApprovalUrl(IDENTITY, "https://openkey.so"));
  expect(url.origin + url.pathname).toBe("https://openkey.so/delegate");
  expect(url.searchParams.get("did")).toBe(IDENTITY.did);
  expect(url.searchParams.get("expiry")).toBe("30d");
  expect(url.searchParams.get("protocolVersion")).toBe("1");
  expect(url.searchParams.has("callback")).toBe(false);
  expect(JSON.parse(atob(url.searchParams.get("jwk")!.replace(/-/g, "+").replace(/_/g, "/")))).toEqual(IDENTITY.publicJwk);
  const envelope = JSON.parse(atob(url.searchParams.get("permissions")!.replace(/-/g, "+").replace(/_/g, "/")));
  expect(envelope.permissions).toEqual(IDENTITY.request.permissions);
});

test("an identity response cannot request a grant over 30 days or expose private key material", () => {
  expect(() => courierApprovalUrl({ ...IDENTITY, request: { ...IDENTITY.request, expiry: "31d" } })).toThrow();
  expect(() => courierApprovalUrl({ ...IDENTITY, publicJwk: { ...IDENTITY.publicJwk, d: "private" } })).toThrow();
});

test("the signed SIWE determines expiry without rewriting the raw OpenKey grant", () => {
  const raw = rawGrant();
  const grant = parseCourierGrant(raw, IDENTITY, OWNER, NOW);
  expect(grant.raw).toBe(raw);
  expect(grant.expiresAt).toBe(UNTIL);
  expect(parseCourierGrant(JSON.stringify(raw), IDENTITY, OWNER, NOW).raw).toEqual(raw);
  expect(parseCourierGrant(btoa(JSON.stringify(raw)), IDENTITY, OWNER, NOW).raw).toEqual(raw);
});

test("wrong owner, wrong TEE key, expired and overlong grants are refused before upload", () => {
  expect(() => parseCourierGrant({ ...rawGrant(), address: "0x" + "22".repeat(20) }, IDENTITY, OWNER, NOW)).toThrow();
  expect(() => parseCourierGrant({ ...rawGrant(), verificationMethod: "did:key:zOther#zOther" }, IDENTITY, OWNER, NOW)).toThrow();
  expect(() => parseCourierGrant({ ...rawGrant(), jwk: { ...IDENTITY.publicJwk, d: "private" } }, IDENTITY, OWNER, NOW)).toThrow();
  expect(() => parseCourierGrant(rawGrant(), IDENTITY, OWNER, UNTIL)).toThrow();
  const tooLong = { ...rawGrant(), siwe: `Issued At: ${new Date(NOW).toISOString()}\nExpiration Time: ${new Date(UNTIL + 1).toISOString()}` };
  expect(() => parseCourierGrant(tooLong, IDENTITY, OWNER, NOW)).toThrow();
});

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

async function render(api: CourierSetupApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<CourierSetup api={api} />));
  return host;
}

function service(expiresAt: number | null = null): CourierSetupApi {
  return {
    owner: OWNER,
    readIdentity: async () => IDENTITY,
    readGrant: async () => ({ expiresAt }),
    redeemCode: async () => rawGrant(),
    saveGrant: async (grant) => ({ expiresAt: grant.expiresAt }),
  };
}

test("a feature-gated 404 renders no Courier controls", async () => {
  const api = service();
  api.readIdentity = async () => { throw new BotsRouteMissing(); };
  const host = await render(api);
  expect(host.innerHTML).toBe("");
});

test("an expired connection offers connect rather than claiming it is connected", async () => {
  const host = await render(service(Date.now() - 60_000));
  expect(host.textContent).toContain("The connection ended on");
  expect(host.textContent).toContain("Connect TrustBot to Courier");
  expect(host.textContent).not.toContain("Connected until");
});

test("before expiration the owner is prompted to renew without opening OpenKey in the background", async () => {
  const host = await render(service(Date.now() + 86_400_000));
  expect(host.textContent).toContain("Renew it to keep your agents connected.");
  const link = host.querySelector("a")!;
  expect(link.textContent).toBe("Renew connection");
  expect(new URL(link.href).pathname).toBe("/delegate");
  expect(host.querySelector("textarea")).toBeNull();
});

test("a redeemed single-use code is retained when uploading fails and is not redeemed twice", async () => {
  const api = service();
  const expiresAt = Date.now() + 7 * 86_400_000;
  const raw = { ...rawGrant(), siwe: `Issued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}` };
  let redeems = 0;
  const uploads: unknown[] = [];
  api.redeemCode = async () => { redeems++; return raw; };
  api.saveGrant = async (grant) => {
    uploads.push(grant);
    if (uploads.length === 1) throw new Error("network");
    return { expiresAt };
  };
  const host = await render(api);
  const link = host.querySelector("a")!;
  link.addEventListener("click", (event) => event.preventDefault());
  await act(async () => link.click());
  const area = host.querySelector("textarea")!;
  area.focus();
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, "ABCD-EFGH");
  await act(async () => {
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("TrustBot couldn't connect to Courier. Try again.");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(redeems).toBe(1);
  expect(uploads).toEqual([{ raw, expiresAt }, { raw, expiresAt }]);
  expect(host.textContent).toContain("Connected until");
  expect(host.querySelector("textarea")).toBeNull();
});

test("cancelling an approval never uploads a grant or changes the connection", async () => {
  const api = service();
  let uploads = 0;
  api.saveGrant = async () => { uploads++; return { expiresAt: UNTIL }; };
  const host = await render(api);
  const link = host.querySelector("a")!;
  link.addEventListener("click", (event) => event.preventDefault());
  await act(async () => link.click());
  const cancel = [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  await act(async () => cancel.click());
  expect(uploads).toBe(0);
  expect(host.textContent).toContain("The connection wasn't approved. Nothing changed.");
  expect(host.querySelector("textarea")).toBeNull();
});
