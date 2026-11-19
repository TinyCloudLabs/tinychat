import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { EmbedHost, SpaceNotHostedError, type EmbedHostDeps, type HostMessage, type SpaceGrant } from "./embedHost";
import { closeAllEmbeds, trackEmbed } from "./liveEmbeds";
import { framedApp, oneApp } from "./registry";
import { courierMissing, missingSpacesLine } from "./strings";

const app = framedApp("xyz.tinycloud.explorer")!;
const owner = { address: "0x1111111111111111111111111111111111111111", chainId: 1 };
const space = (name: string) => `tinycloud:pkh:eip155:1:${owner.address}:${name}`;
const KEY = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SESSION_DID = `did:key:${KEY}#${KEY}`;
const OTHER_KEY = "z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

function setup(options: { held?: (entry: PermissionEntry) => boolean; prompted?: boolean; stepUp?: boolean; unhosted?: string[]; app?: typeof app } = {}) {
  const frame = { name: "frame" };
  const posted: HostMessage[] = [];
  const delegated: Array<{ audience: string; entries: PermissionEntry[] }> = [];
  const stepUps: Array<{ scopes: string[]; entries: PermissionEntry[]; missing: string[] }> = [];
  const missing: Array<{ spaces: string[]; none: boolean }> = [];
  const state = {
    held: options.held ?? ((entry: PermissionEntry) => entry.space === space("applications")),
    stepUp: options.stepUp ?? true,
    unhosted: new Set((options.unhosted ?? []).map(space)),
  };
  let next = 0;
  const deps: EmbedHostDeps = {
    app: options.app ?? app,
    owner,
    frameWindow: () => frame,
    post: (message) => posted.push(message),
    holds: (entries) => entries.every((entry) => state.held(entry)),
    delegate: async (audience, entries): Promise<SpaceGrant> => {
      delegated.push({ audience, entries });
      if (state.unhosted.has(entries[0].space!)) throw new SpaceNotHostedError(entries[0].space!);
      next += 1;
      return { spaceId: entries[0].space!, cid: `cid-${next}`, delegation: `wire-${next}`, expiresAt: 1_000 + next, prompted: options.prompted ?? false };
    },
    stepUp: async (scopes, entries, missingSpaces) => {
      stepUps.push({ scopes, entries, missing: missingSpaces });
      if (state.stepUp) {
        const before = state.held;
        state.held = (entry) => before(entry) || entries.some((granted) => granted.space === entry.space && granted.path === entry.path);
      }
      return state.stepUp;
    },
    missing: (spaces, none) => { missing.push({ spaces, none }); },
    theme: () => "dark",
  };
  const host = new EmbedHost(deps);
  const send = (data: unknown, overrides: { origin?: string; source?: unknown } = {}) =>
    host.handle({ origin: overrides.origin ?? deps.app.origin, source: overrides.source ?? frame, data });
  return { host, frame, posted, delegated, stepUps, missing, state, send };
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

  test("a repeat hello while mounted with unchanged scope re-grants silently", async () => {
    const run = setup();
    await run.send(hello());
    await run.send(hello({ nonce: "nonce-hello-000002" }));
    expect(grants(run.posted).map((message) => message.nonce)).toEqual(["nonce-hello-000001", "nonce-hello-000002"]);
  });

  test("no re-grant after the scope changed", async () => {
    const run = setup();
    await run.send(hello());
    run.state.held = (entry) => entry.space === space("public");
    await run.send(hello({ nonce: "nonce-hello-000002" }));
    expect(grants(run.posted)).toHaveLength(1);
    expect(run.delegated).toHaveLength(1);
  });

  test("no re-grant after unmount; unmount tells the child", async () => {
    const run = setup();
    await run.send(hello());
    await run.host.close();
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/revoke" });
    await run.send(hello({ nonce: "nonce-hello-000002" }));
    expect(grants(run.posted)).toHaveLength(1);
    expect(run.delegated).toHaveLength(1);
  });

  test("nothing is sent when the SDK had to prompt", async () => {
    const run = setup({ prompted: true });
    await run.send(hello());
    expect(run.posted).toEqual([]);
  });

  test("sign-out tells every framed app to drop its key", async () => {
    const run = setup();
    await run.send(hello());
    const untrack = trackEmbed(() => run.host.close());
    await closeAllEmbeds();
    untrack();
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/revoke" });
  });

  test("closing a frame posts tc-embed/revoke to the child and calls no other dep, so no OpenKey frame opens (TC-3483)", async () => {
    const frame = { name: "frame" };
    const posted: HostMessage[] = [];
    const calls: string[] = [];
    let next = 0;
    const base: EmbedHostDeps = {
      app,
      owner,
      frameWindow: () => frame,
      post: (message) => posted.push(message),
      holds: () => true,
      delegate: async (_audience, entries) => {
        next += 1;
        return { spaceId: entries[0].space!, cid: `cid-${next}`, delegation: `wire-${next}`, expiresAt: 1_000 + next, prompted: false };
      },
      stepUp: async () => true,
      missing: () => {},
      theme: () => "dark",
    };
    // Any function dep One wires (delegate, stepUp, or a revoke that signs with the owner's wallet) is recorded.
    const deps = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (...args: unknown[]) => { calls.push(String(prop)); return value(...args); } : value;
      },
    });
    const host = new EmbedHost(deps);
    await host.handle({ origin: app.origin, source: frame, data: hello() });
    calls.length = 0;
    const postedBefore = posted.length;
    await host.close();
    expect(posted.slice(postedBefore)).toEqual([{ v: 1, type: "tc-embed/revoke" }]);
    expect(calls.filter((name) => name !== "post" && name !== "frameWindow")).toEqual([]);
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

  test("an approved request re-grants the space's full scope (old + new) as epoch ms", async () => {
    const run = setup({ held: (entry) => entry.space === space("applications") && entry.service === "tinycloud.kv" });
    await run.send(hello());
    expect(run.delegated[0].entries.map((entry) => entry.service)).toEqual(["tinycloud.kv"]);
    await run.send(request([{ service: "tinycloud.sql", space: "applications", path: "default", actions: ["read"] }]));
    const applications = run.delegated.at(-1)!;
    expect(applications.entries.every((entry) => entry.space === space("applications"))).toBe(true);
    expect(applications.entries.map((entry) => entry.service).sort()).toEqual(["tinycloud.kv", "tinycloud.sql"]);
    const last = grants(run.posted).at(-1)!;
    expect(last.type === "tc-embed/grant" && last.grants).toEqual([{ spaceId: space("applications"), delegation: "wire-2", cid: "cid-2" }]);
  });

  test("expiresAt is epoch milliseconds even when the grant is empty", async () => {
    const run = setup({ held: () => false });
    await run.send(hello());
    const only = grants(run.posted)[0];
    expect(only.type === "tc-embed/grant" && only.grants).toEqual([]);
    expect(only.type === "tc-embed/grant" && only.expiresAt).toBeGreaterThan(1e12);
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

describe("EmbedHost: spaces that aren't set up", () => {
  // Courier opens in a new tab (framed: false); the host's behaviour for its entry is what this block checks.
  const courier = oneApp("xyz.tinycloud.courier");
  if (courier?.kind !== "framed") throw new Error("Courier is a TinyCloud web app");
  const agentsRead = { service: "tinycloud.kv", space: "agents", path: "xyz.tinycloud.courier/", actions: ["get"] };
  const publicRead = { service: "tinycloud.kv", space: "public", path: "", actions: ["get"] };
  const secretsList = { service: "tinycloud.kv", space: "secrets", path: "vault/secrets", actions: ["list"] };
  const deliveredSpaces = (posted: HostMessage[]) =>
    grants(posted).flatMap((message) => (message.type === "tc-embed/grant" ? message.grants.map((grant) => grant.spaceId) : []));

  test("a space the node doesn't host is left out of the grant: the app never gets a delegation for it", async () => {
    const run = setup({ held: (entry) => entry.space === space("applications") || entry.space === space("public"), unhosted: ["public"] });
    await run.send(hello());
    expect(run.delegated.map((call) => call.entries[0].space)).toEqual([space("applications"), space("public")]);
    expect(deliveredSpaces(run.posted)).toEqual([space("applications")]);
    // Silent: nobody asked, so nobody is told.
    expect(run.missing).toEqual([]);
  });

  test("Courier with agents missing: Courier's line with Close only, no OpenKey step, and the app is denied", async () => {
    const run = setup({ app: courier, held: (entry) => entry.space === space("agents"), unhosted: ["agents"] });
    await run.send(hello({ appId: courier.id }));
    await run.send(request([agentsRead]));
    expect(run.stepUps).toEqual([]);
    expect(run.missing).toEqual([{ spaces: ["agents"], none: true }]);
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/denied", nonce: "nonce-request-00001" });
    expect(deliveredSpaces(run.posted)).toEqual([]);
    expect(courierMissing(["agents"])).toBe(true);
    expect(missingSpacesLine(courier.name, ["agents"], true)).toBeUndefined();
  });

  test("Explorer with public missing: the card asks only for what exists and says nothing about public", async () => {
    const run = setup({ held: (entry) => entry.space === space("applications") || entry.space === space("public"), unhosted: ["public"] });
    await run.send(hello());
    await run.send(request([publicRead, secretsList]));
    expect(run.stepUps).toHaveLength(1);
    expect(run.stepUps[0].scopes).toEqual(["secretNames"]);
    expect(run.stepUps[0].entries.every((entry) => entry.space === space("secrets"))).toBe(true);
    expect(run.stepUps[0].missing).toEqual(["public"]);
    expect(missingSpacesLine(app.name, run.stepUps[0].missing, false)).toBeUndefined();
    expect(courierMissing(run.stepUps[0].missing)).toBe(false);
    expect(deliveredSpaces(run.posted).filter((spaceId) => spaceId === space("public"))).toEqual([]);
  });

  test("a space set up since the silent grant is checked again", async () => {
    const run = setup({ held: (entry) => entry.space === space("applications") || entry.space === space("public"), unhosted: ["public"] });
    await run.send(hello());
    run.state.unhosted.clear();
    await run.send(request([publicRead]));
    expect(run.stepUps).toEqual([]);
    expect(run.missing).toEqual([]);
    const last = grants(run.posted).at(-1)!;
    expect(last.type === "tc-embed/grant" && last.grants.map((grant) => grant.spaceId)).toEqual([space("applications"), space("public")]);
  });

  test("a space found missing only after the approval is left out and named then", async () => {
    const run = setup({ unhosted: ["secrets"] });
    await run.send(hello());
    await run.send(request([secretsList]));
    expect(run.stepUps).toHaveLength(1);
    expect(run.stepUps[0].missing).toEqual([]);
    expect(deliveredSpaces(run.posted)).toEqual([space("applications"), space("applications")]);
    expect(run.missing).toEqual([{ spaces: ["secrets"], none: true }]);
  });
});

describe("missing-space copy", () => {
  test("one missing next to spaces that exist", () => {
    expect(missingSpacesLine("Explorer", ["secrets"], false)).toBe(
      "Explorer also uses Secrets, which isn't set up in your TinyCloud. Open Secrets once to set it up, then come back to give Explorer access to it.",
    );
  });

  test("two missing next to spaces that exist; public says nothing", () => {
    expect(missingSpacesLine("Account", ["credentials", "public", "secrets"], false)).toBe(
      "Account also uses Credentials and Secrets, which aren't set up in your TinyCloud. Open each once to set it up, then come back to give Account access to them.",
    );
  });

  test("none exist, one and two", () => {
    expect(missingSpacesLine("Explorer", ["secrets"], true)).toBe(
      "Explorer uses Secrets, which isn't set up in your TinyCloud. Open Secrets once to set it up, then come back to give Explorer access.",
    );
    expect(missingSpacesLine("Explorer", ["secrets", "account"], true)).toBe(
      "Explorer uses Secrets and Account, which aren't set up in your TinyCloud. Open each once to set it up, then come back to give Explorer access.",
    );
  });

  test("the app's own space missing: its own line, with or without other spaces existing", () => {
    const own = "Credentials isn't set up in your TinyCloud. Open Credentials once to set it up, then come back to give it access.";
    expect(missingSpacesLine("Credentials", ["credentials"], true)).toBe(own);
    expect(missingSpacesLine("Credentials", ["credentials"], false)).toBe(own);
  });

  test("the app's own space and others: its own line first, then the usual line for the rest", () => {
    expect(missingSpacesLine("Account", ["secrets", "account"], false)).toBe(
      "Account isn't set up in your TinyCloud. Open Account once to set it up, then come back to give it access. Account also uses Secrets, which isn't set up in your TinyCloud. Open Secrets once to set it up, then come back to give Account access to it.",
    );
    expect(missingSpacesLine("Account", ["account", "credentials", "secrets"], true)).toBe(
      "Account isn't set up in your TinyCloud. Open Account once to set it up, then come back to give it access. Account uses Credentials and Secrets, which aren't set up in your TinyCloud. Open each once to set it up, then come back to give Account access.",
    );
  });

  test("public, applications and agents never join the Open line", () => {
    expect(missingSpacesLine("Explorer", ["public", "applications", "agents"], true)).toBeUndefined();
  });
});
