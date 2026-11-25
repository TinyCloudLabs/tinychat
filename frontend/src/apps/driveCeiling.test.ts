// Drive (TinyDrive) inside One: what One will ever hand it, and what it does with a request from the frame.
import { describe, expect, test } from "bun:test";
import { EmbedHost, type EmbedHostDeps, type HostMessage } from "./embedHost";
import { framedApp, framesAppHere, frameUrl, NATIVE_STEP_UP_CEILINGS, ONE_NATIVE_ORIGINS, oneAppsFor, type FramedOneApp } from "./registry";
import { clampRequest, resolveCeiling } from "./scope";
import { joinScopes, SCOPE_PHRASES } from "./strings";

const READ_ONLY = ["get", "list", "metadata"];
const OWNER = { address: "0x0000000000000000000000000000000000000001", chainId: 1 };
const ORIGIN = "https://drive.tinycloud.xyz";
const SESSION = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const space = (name: string) => `tinycloud:pkh:eip155:1:${OWNER.address}:${name}`;
// What TinyDrive sends when the owner opens a drive (tinydrive web/src/drive.js embedPermissions).
const ask = (name: string) => [{ service: "tinycloud.kv", space: name, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata"] }];

function driveOn(platform: string): FramedOneApp | undefined {
  const app = oneAppsFor(platform).find((entry) => entry.id === "xyz.tinycloud.tinydrive");
  return app?.kind === "framed" ? app : undefined;
}

describe("Drive inside One", () => {
  const drive = framedApp("xyz.tinycloud.tinydrive")!;

  test("is framed from exactly its own origin, at its root, in embedded mode", () => {
    expect(drive.origin).toBe(ORIGIN);
    expect(frameUrl(drive)).toBe(`${ORIGIN}/?embed=one`);
    expect(framesAppHere(drive, "https://tinycloud.one")).toBe(true);
  });

  for (const platform of ["web", "android", "ios"]) {
    test(`${platform}: the ceiling is three whole spaces, to list and read only`, () => {
      const entries = driveOn(platform)!.ceiling(OWNER);
      expect(entries.map(({ permission }) => [permission.service, permission.space, permission.path])).toEqual([
        ["tinycloud.kv", "applications", ""],
        ["tinycloud.kv", "default", ""],
        ["tinycloud.kv", "agents", ""],
      ]);
      for (const { permission } of entries) expect(permission.actions).toEqual(READ_ONLY);
    });
  }

  test("no secrets, no SQL, no account space, no list of grants, and nothing that writes or deletes", () => {
    const entries = drive.ceiling(OWNER).map(({ permission }) => permission);
    expect(entries.filter((entry) => entry.service !== "tinycloud.kv")).toEqual([]);
    expect(entries.filter((entry) => ["secrets", "account", "public", "credentials", "messages"].includes(entry.space ?? ""))).toEqual([]);
    const ceiling = resolveCeiling(OWNER, drive.ceiling(OWNER));
    for (const name of ["applications", "default", "agents"]) {
      expect(clampRequest(OWNER, ceiling, ask(name))).toHaveLength(1);
      for (const action of ["put", "del", "delete"]) {
        expect(clampRequest(OWNER, ceiling, [{ service: "tinycloud.kv", space: name, path: "", actions: [action] }])).toBeUndefined();
      }
      expect(clampRequest(OWNER, ceiling, [{ service: "tinycloud.sql", space: name, path: "default", actions: ["read"] }])).toBeUndefined();
      expect(clampRequest(OWNER, ceiling, [{ service: "tinycloud.delegation", space: name, path: "", actions: ["list"] }])).toBeUndefined();
    }
    expect(clampRequest(OWNER, ceiling, ask("secrets"))).toBeUndefined();
    expect(clampRequest(OWNER, ceiling, ask("account"))).toBeUndefined();
  });

  test("the ask card names each drive in plain words", () => {
    expect(drive.ceiling(OWNER).map(({ scope }) => scope)).toEqual(["appsData", "ownFiles", "agentsData"]);
    expect(joinScopes(["ownFiles"])).toBe(SCOPE_PHRASES.ownFiles);
    expect(SCOPE_PHRASES.ownFiles).toContain("read only");
    expect(SCOPE_PHRASES.agentsData).toContain("read only");
  });

  test("the phone app does not frame it and has no step-up for it", () => {
    expect(drive.inNativeApp).toBe(false);
    for (const origin of ONE_NATIVE_ORIGINS) expect(framesAppHere(drive, origin)).toBe(false);
    expect(NATIVE_STEP_UP_CEILINGS["xyz.tinycloud.tinydrive"]).toBeUndefined();
  });

  // The frame's own flow: hello hands over only what One already holds; a drive One doesn't hold is put to the owner once.
  function host(held: Set<string>, approve: boolean) {
    const frame = {};
    const posted: HostMessage[] = [];
    const asked: Array<{ scopes: string[]; spaces: Array<string | undefined>; actions: string[][] }> = [];
    const delegated: Array<{ audience: string; spaces: Array<string | undefined>; actions: string[][] }> = [];
    const deps: EmbedHostDeps = {
      app: drive,
      owner: OWNER,
      frameWindow: () => frame,
      post: (message) => { posted.push(message); },
      holds: (entries) => entries.every((entry) => held.has(entry.space ?? "")),
      delegate: async (audience, entries) => {
        delegated.push({ audience, spaces: entries.map((entry) => entry.space), actions: entries.map((entry) => entry.actions) });
        return { spaceId: entries[0]!.space!, cid: "bafy-test", delegation: "serialized", expiresAt: Date.now() + 3_600_000, prompted: false };
      },
      stepUp: async (scopes, entries) => {
        asked.push({ scopes, spaces: entries.map((entry) => entry.space), actions: entries.map((entry) => entry.actions) });
        if (approve) for (const entry of entries) held.add(entry.space ?? "");
        return approve;
      },
      missing: () => {},
      theme: () => "light",
    };
    const embed = new EmbedHost(deps);
    const send = (data: unknown, origin = ORIGIN) => embed.handle({ origin, source: frame, data });
    return { send, posted, asked, delegated };
  }
  const hello = { v: 1, type: "tc-embed/hello", appId: "xyz.tinycloud.tinydrive", sessionDid: SESSION, nonce: "AAAAAAAAAAAAAAAAAAAAAA" };
  const request = (name: string, nonce: string) => ({ v: 1, type: "tc-embed/request", nonce, permissions: ask(name) });

  test("hello hands over nothing One doesn't already hold, and asks the owner nothing", async () => {
    const run = host(new Set(), true);
    await run.send(hello);
    expect(run.asked).toEqual([]);
    expect(run.delegated).toEqual([]);
    expect(run.posted).toHaveLength(1);
    expect(run.posted[0]).toMatchObject({ type: "tc-embed/grant", grants: [] });
  });

  test("opening My files asks the owner for that one space, read only, then grants it to the frame's key", async () => {
    const run = host(new Set([space("applications")]), true);
    await run.send(hello);
    await run.send(request("default", "BBBBBBBBBBBBBBBBBBBBBB"));
    expect(run.asked).toEqual([{ scopes: ["ownFiles"], spaces: [space("default")], actions: [READ_ONLY] }]);
    const last = run.delegated.filter((grant) => grant.spaces.includes(space("default")));
    expect(last).toEqual([{ audience: SESSION, spaces: [space("default")], actions: [READ_ONLY] }]);
    expect(run.posted.at(-1)).toMatchObject({ type: "tc-embed/grant", nonce: "BBBBBBBBBBBBBBBBBBBBBB" });
  });

  test("Not now: the frame is told denied and gets no grant for that space", async () => {
    const run = host(new Set([space("applications")]), false);
    await run.send(hello);
    await run.send(request("agents", "CCCCCCCCCCCCCCCCCCCCCC"));
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/denied", nonce: "CCCCCCCCCCCCCCCCCCCCCC" });
    expect(run.delegated.some((grant) => grant.spaces.includes(space("agents")))).toBe(false);
  });

  test("a request outside the ceiling is denied without asking the owner", async () => {
    const run = host(new Set([space("applications")]), true);
    await run.send(hello);
    await run.send({ v: 1, type: "tc-embed/request", nonce: "DDDDDDDDDDDDDDDDDDDDDD", permissions: [{ service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/put"] }] });
    expect(run.asked).toEqual([]);
    expect(run.posted.at(-1)).toEqual({ v: 1, type: "tc-embed/denied", nonce: "DDDDDDDDDDDDDDDDDDDDDD" });
  });

  test("messages from any other origin are ignored", async () => {
    const run = host(new Set([space("applications")]), true);
    for (const origin of ["http://drive.tinycloud.xyz", "https://drive.tinycloud.xyz.evil.example", "https://tinydrive.pages.dev", "https://localhost:5197", "https://explorer.tinycloud.xyz"]) {
      await run.send(hello, origin);
    }
    expect(run.posted).toEqual([]);
    expect(run.delegated).toEqual([]);
  });
});
