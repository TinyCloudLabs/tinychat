// The Ship ledger inside One (TC-3768): exactly the sitrep's read-only prefixes, framed only from its one production
// origin, on every platform.
import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { EmbedHost, type EmbedHostDeps, type HostMessage, type SpaceGrant } from "./embedHost";
import { NATIVE_STEP_UP_CEILINGS, appTarget, framedApp, frameUrl, oneAppsFor, type FramedOneApp } from "./registry";

// A copy of the sitrep's ONE_LEDGER_PREFIXES (rocinante-sitrep shared/one-ceiling.ts). A change on either side must
// change both.
const ONE_LEDGER_PREFIXES = [
  "board/ask/", "board/task/", "board/incident/", "board/work/", "board/ship/", "board/order/", "board/claim/",
  "board/hold/", "board/progress/", "board/report/", "board/sam-ask/", "board/release/", "board/release-off/",
  "board/release-blocker/", "board/sam-ask-check/", "board/ledger-inventory/", "board/ledger-dispatch/",
  "sam/answers/", "sam/state/",
];
const ORIGIN = "https://rocinante-ledger.pages.dev";
const ID = "xyz.tinycloud.rocinante.ledger";
const owner = { address: "0x1111111111111111111111111111111111111111", chainId: 1 };
const space = (name: string) => `tinycloud:pkh:eip155:1:${owner.address}:${name}`;
const KEY = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const ledgerOn = (platform: string) => {
  const app = oneAppsFor(platform, true).find((candidate) => candidate.id === ID);
  if (app?.kind !== "framed") throw new Error(`no Ledger on ${platform}`);
  return app;
};

function host(app: FramedOneApp, held: (entry: PermissionEntry) => boolean) {
  const frame = { name: "frame" };
  const posted: HostMessage[] = [];
  const delegated: PermissionEntry[] = [];
  const stepUps: string[][] = [];
  const deps: EmbedHostDeps = {
    app,
    owner,
    frameWindow: () => frame,
    post: (message) => posted.push(message),
    holds: (entries) => entries.every(held),
    delegate: async (_audience, entries): Promise<SpaceGrant> => {
      delegated.push(...entries);
      return { spaceId: entries[0].space!, cid: "cid", delegation: "wire", expiresAt: 1_000, prompted: false };
    },
    stepUp: async (scopes) => {
      stepUps.push(scopes);
      return false;
    },
    missing: () => {},
    theme: () => "dark",
  };
  const embed = new EmbedHost(deps);
  const send = (data: unknown, origin = app.origin) => embed.handle({ origin, source: frame, data });
  const hello = { v: 1, type: "tc-embed/hello", appId: app.id, sessionDid: `did:key:${KEY}#${KEY}`, nonce: "nonce-hello-000001" };
  return { posted, delegated, stepUps, send, hello };
}

describe("Ship ledger inside One (TC-3768)", () => {
  for (const platform of ["web", "ios", "android"]) {
    test(`${platform}: the ceiling is exactly the sitrep's prefixes in applications, read only`, () => {
      expect(ledgerOn(platform).ceiling(owner).map(({ permission }) => permission)).toEqual(
        ONE_LEDGER_PREFIXES.map((prefix) => ({
          service: "tinycloud.kv",
          space: "applications",
          path: `xyz.tinycloud.rocinante/${prefix}`,
          actions: ["get", "list", "metadata"],
          skipPrefix: true,
        })),
      );
    });
  }

  test("no approval links and not the whole board", () => {
    const paths = ledgerOn("web").ceiling(owner).map(({ permission }) => permission.path);
    expect(paths.some((path) => path.startsWith("xyz.tinycloud.rocinante/board/approval"))).toBe(false);
    expect(paths).not.toContain("xyz.tinycloud.rocinante/board/");
    expect(paths).not.toContain("xyz.tinycloud.rocinante/");
  });

  test("framed from exactly its production origin; the phone app frames it too; it never asks OpenKey from the phone", () => {
    const ledger = ledgerOn("web");
    expect(ledger.origin).toBe(ORIGIN);
    expect(new URL(frameUrl(ledger)).origin).toBe(ORIGIN);
    expect(appTarget(ledger, "https://tinycloud.one")).toEqual({ kind: "route", path: `/chat/apps/${ID}` });
    for (const origin of ["capacitor://localhost", "https://localhost"]) {
      expect(appTarget(ledger, origin)).toEqual({ kind: "route", path: `/chat/apps/${ID}` });
    }
    expect(Object.keys(NATIVE_STEP_UP_CEILINGS)).not.toContain(ID);
  });

  test("previews, branch aliases and dev origins get no grant", async () => {
    const ledger = framedApp(ID)!;
    for (const origin of [
      "https://0a1b2c3d.rocinante-ledger.pages.dev",
      "https://feat-ledger-one.rocinante-ledger.pages.dev",
      "http://rocinante-ledger.pages.dev",
      "https://rocinante-ledger.pages.dev.evil.example",
      "https://localhost:5196",
    ]) {
      const run = host(ledger, () => true);
      await run.send(run.hello, origin);
      expect(run.delegated).toEqual([]);
      expect(run.posted).toEqual([]);
    }
  });

  test("with Explorer's, Courier's and the Ledger's access all held, the Ledger's frame gets only its own", async () => {
    const ledger = framedApp(ID)!;
    const run = host(ledger, () => true);
    await run.send(run.hello);
    expect(run.delegated).toEqual(ledger.ceiling(owner).map(({ permission }) => ({ ...permission, space: space("applications") })));
    const granted = run.delegated.length;
    await run.send({ v: 1, type: "tc-embed/request", nonce: "nonce-request-00001", permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["get", "list"] }] });
    await run.send({ v: 1, type: "tc-embed/request", nonce: "nonce-request-00002", permissions: [{ service: "tinycloud.kv", space: "agents", path: "xyz.tinycloud.courier/", actions: ["get"] }] });
    await run.send({ v: 1, type: "tc-embed/request", nonce: "nonce-request-00003", permissions: [{ service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.rocinante/board/approval/", actions: ["get"] }] });
    await run.send({ v: 1, type: "tc-embed/request", nonce: "nonce-request-00004", permissions: [{ service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.rocinante/board/task/", actions: ["put"] }] });
    expect(run.delegated).toHaveLength(granted);
    expect(run.stepUps).toEqual([]);
    expect(run.posted.filter((message) => message.type === "tc-embed/denied")).toHaveLength(4);
  });
});
