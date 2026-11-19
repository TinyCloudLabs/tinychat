import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { EmbedHost, type EmbedHostDeps, type HostMessage, type SpaceGrant } from "./embedHost";
import { closeAllEmbeds, trackEmbed } from "./liveEmbeds";
import { framedApp } from "./registry";

const app = framedApp("xyz.tinycloud.explorer")!;
const owner = { address: "0x1111111111111111111111111111111111111111", chainId: 1 };
const space = (name: string) => `tinycloud:pkh:eip155:1:${owner.address}:${name}`;
const KEY = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SESSION_DID = `did:key:${KEY}#${KEY}`;
const OTHER_KEY = "z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

function setup(options: { held?: (entry: PermissionEntry) => boolean; prompted?: boolean; stepUp?: boolean } = {}) {
  const frame = { name: "frame" };
  const posted: HostMessage[] = [];
  const delegated: Array<{ audience: string; entries: PermissionEntry[] }> = [];
  const revoked: string[] = [];
  const stepUps: Array<{ scopes: string[]; entries: PermissionEntry[] }> = [];
  const state = { held: options.held ?? ((entry: PermissionEntry) => entry.space === space("applications")), stepUp: options.stepUp ?? true };
  let next = 0;
  const deps: EmbedHostDeps = {
    app,
    owner,
    frameWindow: () => frame,
    post: (message) => posted.push(message),
    holds: (entries) => entries.every((entry) => state.held(entry)),
    delegate: async (audience, entries): Promise<SpaceGrant> => {
      delegated.push({ audience, entries });
      next += 1;
      return { spaceId: entries[0].space!, cid: `cid-${next}`, delegation: `wire-${next}`, expiresAt: 1_000 + next, prompted: options.prompted ?? false };
    },
    revoke: async (cid) => { revoked.push(cid); },
    stepUp: async (scopes, entries) => {
      stepUps.push({ scopes, entries });
      if (state.stepUp) {
        const before = state.held;
        state.held = (entry) => before(entry) || entries.some((granted) => granted.space === entry.space && granted.path === entry.path);
      }
      return state.stepUp;
    },
    theme: () => "dark",
  };
  const host = new EmbedHost(deps);
  const send = (data: unknown, overrides: { origin?: string; source?: unknown } = {}) =>
    host.handle({ origin: overrides.origin ?? app.origin, source: overrides.source ?? frame, data });
  return { host, frame, posted, delegated, revoked, stepUps, state, send };
}

const hello = (overrides: Record<string, unknown> = {}) => ({ v: 1, type: "tc-embed/hello", appId: app.id, sessionDid: SESSION_DID, nonce: "nonce-hello-000001", ...overrides });
const request = (permissions: unknown[], nonce = "nonce-request-00001") => ({ v: 1, type: "tc-embed/request", nonce, permissions });
const grants = (posted: HostMessage[]) => posted.filter((message) => message.type === "tc-embed/grant");

describe("EmbedHost: who it listens to", () => {
  test("a hello from another origin is rejected", async () => {
    const run = setup();
    await run.send(hello(), { origin: "https://evil.example" });
    await run.send(hello(), { origin: "http://explorer.tinycloud.xyz" });
    expect(run.posted).toEqual([]);
    expect(run.delegated).toEqual([]);
  });

  test("a hello from another window is rejected", async () => {
    const run = setup();
    await run.send(hello(), { source: { name: "another frame" } });
    expect(run.posted).toEqual([]);
    expect(run.delegated).toEqual([]);
  });

  test("a hello naming another app, another version, or a malformed nonce is ignored", async () => {
    const run = setup();
    await run.send(hello({ appId: "xyz.tinycloud.secrets" }));
    await run.send(hello({ v: 2 }));
    await run.send(hello({ nonce: "short" }));
    await run.send(hello({ sessionDid: "did:pkh:eip155:1:0xabc" }));
    expect(run.posted).toEqual([]);
  });

  test("a second hello from the frame with a different sessionDid is rejected", async () => {
    const run = setup();
    await run.send(hello());
    await run.send(hello({ sessionDid: `did:key:${OTHER_KEY}`, nonce: "nonce-hello-000002" }));
    expect(grants(run.posted)).toHaveLength(1);
    expect(run.delegated.every(({ audience }) => audience === `did:key:${KEY}`)).toBe(true);
  });
});

describe("EmbedHost: silent grants", () => {
  test("first hello: one delegation per held space, to the session key without its fragment, echoing the nonce", async () => {
    const run = setup({ held: (entry) => entry.space === space("applications") || entry.space === space("public") });
    await run.send(hello());
    expect(run.delegated.map(({ audience, entries }) => [audience, entries[0].space])).toEqual([
      [`did:key:${KEY}`, space("applications")],
      [`did:key:${KEY}`, space("public")],
    ]);
    expect(run.delegated.every(({ entries }) => new Set(entries.map((entry) => entry.space)).size === 1)).toBe(true);
    expect(grants(run.posted)).toEqual([{
      v: 1,
      type: "tc-embed/grant",
      nonce: "nonce-hello-000001",
      grants: [
        { spaceId: space("applications"), delegation: "wire-1", cid: "cid-1" },
        { spaceId: space("public"), delegation: "wire-2", cid: "cid-2" },
      ],
      expiresAt: 1_001,
      theme: "dark",
    }]);
  });

  test("the grant never exceeds the ceiling, even when One holds more", async () => {
    const run = setup({ held: () => true });
    await run.send(hello());
    const ceiling = app.ceiling(owner).length;
    expect(run.delegated.flatMap(({ entries }) => entries)).toHaveLength(ceiling);
  });

  test("a repeat hello while mounted with unchanged scope re-grants silently and revokes the old grant", async () => {
    const run = setup();
    await run.send(hello());
    await run.send(hello({ nonce: "nonce-hello-000002" }));
    expect(grants(run.posted).map((message) => message.nonce)).toEqual(["nonce-hello-000001", "nonce-hello-000002"]);
    expect(run.revoked).toEqual(["cid-1"]);
  });

  test("no re-grant after the scope changed", async () => {
    const run = setup();
    await run.send(hello());
    run.state.held = (entry) => entry.space === space("public");
    await run.send(hello({ nonce: "nonce-hello-000002" }));
    expect(grants(run.posted)).toHaveLength(1);
    expect(run.delegated).toHaveLength(1);
  });

  test("no re-grant after unmount; unmount revokes the live grant and tells the child", async () => {
    const run = setup();
    await run.send(hello());
    await run.host.close();
    expect(run.revoked).toEqual(["cid-1"]);
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/revoke" });
    await run.send(hello({ nonce: "nonce-hello-000002" }));
    expect(grants(run.posted)).toHaveLength(1);
    expect(run.delegated).toHaveLength(1);
  });

  test("nothing is sent when the SDK had to prompt, and what it made is revoked", async () => {
    const run = setup({ prompted: true });
    await run.send(hello());
    expect(run.posted).toEqual([]);
    expect(run.revoked).toEqual(["cid-1"]);
  });

  test("sign-out revokes every framed app's grant", async () => {
    const run = setup();
    await run.send(hello());
    const untrack = trackEmbed(() => run.host.close());
    await closeAllEmbeds();
    untrack();
    expect(run.revoked).toEqual(["cid-1"]);
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/revoke" });
  });
});

describe("EmbedHost: requests", () => {
  const publicRead = { service: "tinycloud.kv", space: "public", path: "", actions: ["tinycloud.kv/get"] };

  test("a request outside the ceiling is denied without asking", async () => {
    const run = setup();
    await run.send(hello());
    await run.send(request([{ service: "tinycloud.kv", space: "public", path: "", actions: ["put"] }]));
    await run.send(request([{ service: "tinycloud.kv", space: "account", path: "spaces/", actions: ["get"] }], "nonce-request-00002"));
    expect(run.stepUps).toEqual([]);
    expect(run.posted.filter((message) => message.type === "tc-embed/denied")).toEqual([
      { v: 1, type: "tc-embed/denied", nonce: "nonce-request-00001" },
      { v: 1, type: "tc-embed/denied", nonce: "nonce-request-00002" },
    ]);
  });

  test("a request inside the ceiling asks once, steps up, then grants one delegation per space", async () => {
    const run = setup();
    await run.send(hello());
    await run.send(request([publicRead, { service: "tinycloud.kv", space: space("secrets"), path: "vault/secrets", actions: ["list"] }]));
    expect(run.stepUps).toHaveLength(1);
    expect(run.stepUps[0].scopes).toEqual(["publicSpace", "secretNames"]);
    expect(new Set(run.stepUps[0].entries.map((entry) => entry.space))).toEqual(new Set([space("public"), space("secrets")]));
    const last = grants(run.posted).at(-1)!;
    expect(last.type === "tc-embed/grant" && last.nonce).toBe("nonce-request-00001");
    expect(last.type === "tc-embed/grant" && last.grants.map((grant) => grant.spaceId)).toEqual([space("applications"), space("public"), space("secrets")]);
  });

  test("Not now answers denied and grants nothing new", async () => {
    const run = setup({ stepUp: false });
    await run.send(hello());
    await run.send(request([publicRead]));
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/denied", nonce: "nonce-request-00001" });
    expect(grants(run.posted)).toHaveLength(1);
  });

  test("a request before any hello is ignored", async () => {
    const run = setup();
    await run.send(request([publicRead]));
    expect(run.posted).toEqual([]);
    expect(run.stepUps).toEqual([]);
  });
});
