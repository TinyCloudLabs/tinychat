import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { BotsRouteMissing } from "./botsApi";
import { READ_AREAS } from "./trustbotReadAreas";
import { readSettings, setReadArea, signReadGrant } from "./trustbotReadGrant";

let restore: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; restore?.(); });

const DID = "did:pkh:eip155:1:0x" + "11".repeat(20);
const BODY = { serviceDid: DID, expiresAt: 123, areas: { meetings: "on" } };

function setup(response: Response = Response.json(BODY)) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
}

function client({ allowed = true, prompted = false } = {}) {
  const asked: PermissionEntry[][] = [];
  const tcw = {
    session: () => ({ siwe: `Expiration Time: ${new Date(Date.now() + 86_400_000).toISOString()}`, signature: "fixture" }),
    hasPermissions: (permissions: PermissionEntry[]) => { asked.push(permissions); return allowed; },
    delegateTo: async (_did: string, permissions: PermissionEntry[], options: { expiry: number }) => {
      asked.push(permissions);
      expect(options.expiry).toBeLessThanOrEqual(86_400_000);
      if (prompted) return { prompted: true };
      throw new Error("reached_delegation");
    },
    hosts: [],
  } as unknown as TinyCloudWeb;
  return { tcw, asked };
}

test("the grant asks for exactly the meetings entries", async () => {
  setup();
  const { tcw, asked } = client();
  await expect(signReadGrant(tcw, DID, ["meetings"])).rejects.toThrow("reached_delegation");
  expect(asked[0]).toEqual(READ_AREAS.meetings);
  expect(asked[1]).toEqual(READ_AREAS.meetings);
});

test("missing authority refuses before delegation and sends nothing", async () => {
  setup();
  const { tcw, asked } = client({ allowed: false });
  await expect(signReadGrant(tcw, DID, ["meetings"])).rejects.toThrow("read_authority_missing");
  expect(asked).toHaveLength(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a delegation that prompted the owner is refused and sends nothing", async () => {
  setup();
  const { tcw } = client({ prompted: true });
  await expect(signReadGrant(tcw, DID, ["meetings"])).rejects.toThrow("read_unexpected_approval");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("settings come from GET /api/bots/main/reads with the session token", async () => {
  setup();
  expect(await readSettings()).toEqual(BODY as never);
  const [url, init] = fetchSpy!.mock.calls[0] as [string, RequestInit];
  expect(url.endsWith("/api/bots/main/reads")).toBe(true);
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-token");
});

test("a 404 means the feature is not available", async () => {
  setup(new Response(null, { status: 404 }));
  await expect(readSettings()).rejects.toBeInstanceOf(BotsRouteMissing);
});

test("turning an area on and off PUTs the contract bodies", async () => {
  setup();
  const grant = { serialized: "s", siwe: "w", signature: "g" };
  await setReadArea("meetings", true, grant);
  fetchSpy!.mockResolvedValue(Response.json(BODY));
  await setReadArea("meetings", false);
  const calls = fetchSpy!.mock.calls as [string, RequestInit][];
  expect(calls[0]![0].endsWith("/api/bots/main/reads/meetings")).toBe(true);
  expect(calls[0]![1].method).toBe("PUT");
  expect(JSON.parse(calls[0]![1].body as string)).toEqual({ enabled: true, grant });
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ enabled: false });
});
