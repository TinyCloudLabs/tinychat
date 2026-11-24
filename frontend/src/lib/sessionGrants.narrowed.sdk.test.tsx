// What One's web sign-in holds in the applications KV once the broad root is narrowed (manifest revision 5), on the
// installed web SDK, and what that means for the two apps that used the root: the Ledger keeps its folder with no
// prompt, Explorer's all-apps read now asks (step-up). The real SDK signs the session; the node is a stub.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "./homeFeatures";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";
import { EmbedHost, spaceName, type EmbedHostDeps, type HostMessage, type SpaceGrant } from "../apps/embedHost";
import { ONE_APPS, framedApp, type FramedOneApp } from "../apps/registry";
import { listedApps, presentKeys } from "../apps/listedApps";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST };
const OWNER = { address: ADDRESS, chainId: 1 };
const KEY = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const LEDGER_ID = "xyz.tinycloud.rocinante.ledger";
const EXPLORER_ID = "xyz.tinycloud.explorer";
const realFetch = globalThis.fetch;
let restoreDom: () => void;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.pathname.includes("/locations/")) return Response.json({ error: "location record not found" }, { status: 404 });
    return new Response(
      url.pathname.endsWith("/info") ? JSON.stringify({ protocol: 1, version: "test", features: ["kv", "delegation", "sql", "hooks", "encryption", "encryption-named-keys-v1"], nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }) : "{}",
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  restoreDom = installDom();
  atOrigin();
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
    clear: () => data.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});
afterEach(() => { restoreDom(); Reflect.deleteProperty(globalThis, "localStorage"); });

const wallet = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [ADDRESS];
    if (method === "eth_chainId") return "0x1";
    if (method === "personal_sign") {
      const raw = String(params![0]);
      const message = raw.startsWith("0x") ? Buffer.from(raw.slice(2), "hex").toString("utf8") : raw;
      return account.signMessage({ message });
    }
    throw new Error(`unsupported ${method}`);
  },
} as EIP1193Provider;

async function signIn() {
  const tcw = createTinyCloudWeb(wallet, { ...config, manifest: webSignInManifest(WEB_APP_MANIFEST, [], ADDRESS) });
  const session = await tcw.signIn();
  return { tcw, siwe: session.siwe };
}

function resources(siwe: string): string[] {
  const att = [...siwe.matchAll(/urn:recap:([A-Za-z0-9_-]+)/g)].flatMap((match) => {
    const recap = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { att: Record<string, unknown> };
    return Object.keys(recap.att);
  });
  return att;
}

const kv = (path: string, actions: string[]): PermissionEntry => ({ service: "tinycloud.kv", space: "applications", path, actions, skipPrefix: true });

describe("One's web sign-in, with the applications KV root narrowed", () => {
  test("the session holds no applications KV root and holds the Ledger folder and its own KV", async () => {
    const { tcw, siwe } = await signIn();
    const held = resources(siwe).filter((resource) => resource.includes(":applications/kv"));
    expect(held.some((resource) => resource.endsWith(":applications/kv"))).toBe(false);
    expect(held.some((resource) => resource.endsWith(":applications/kv/xyz.tinycloud.rocinante/"))).toBe(true);
    // Every KV folder One's own screens read and write, including the one the old root used to cover silently.
    for (const path of ["threads/", "connectors/", "exo/v1/requests/", "exo/v1/jobs/", "exo/voiceNotes/hostedJobs/"]) {
      const actions = path === "exo/v1/requests/" ? ["get", "list", "del"] : ["get", "put", "del"];
      expect(tcw.hasPermissions([kv(`xyz.tinycloud.tinychat/${path}`, actions)])).toBe(true);
    }
    expect(tcw.hasPermissions([kv("xyz.tinycloud.tinychat/exo/voiceNotes/hostedJobs/", ["list"])])).toBe(true);
  });

  test("the Ledger folder is read only: neither a write there nor a read elsewhere is held", async () => {
    const { tcw } = await signIn();
    expect(tcw.hasPermissions([kv("xyz.tinycloud.rocinante/board/ask/", ["get", "list", "metadata"])])).toBe(true);
    expect(tcw.hasPermissions([kv("xyz.tinycloud.rocinante/board/ask/", ["put"])])).toBe(false);
    expect(tcw.hasPermissions([kv("xyz.tinycloud.rocinante/board/ask/", ["del"])])).toBe(false);
    expect(tcw.hasPermissions([kv("xyz.tinycloud.courier/", ["get"])])).toBe(false);
    expect(tcw.hasPermissions([kv("", ["get", "list"])])).toBe(false);
  });

  test("the Ledger's listing check reads its key on One's own session", async () => {
    const { tcw } = await signIn();
    const ledger = framedApp(LEDGER_ID)!;
    expect(ledger.listedIf).toBe("xyz.tinycloud.rocinante/board/release-relay.json");
    expect(tcw.hasPermissions([kv(ledger.listedIf!, ["metadata"])])).toBe(true);
    // The check itself, with a reader that answers as the node would for a held key.
    const present = await presentKeys({ kv: { head: async (key) => ({ ok: tcw.hasPermissions([kv(key, ["metadata"])]) }) } }, ONE_APPS);
    expect(listedApps(ONE_APPS, present).some((app) => app.id === LEDGER_ID)).toBe(true);
  });
});

function host(app: FramedOneApp, tcw: { hasPermissions(entries: PermissionEntry[]): boolean }) {
  const frame = { name: "frame" };
  const posted: HostMessage[] = [];
  const delegated: PermissionEntry[] = [];
  const stepUps: PermissionEntry[][] = [];
  const deps: EmbedHostDeps = {
    app,
    owner: OWNER,
    frameWindow: () => frame,
    post: (message) => posted.push(message),
    holds: (entries) => tcw.hasPermissions(entries.map((entry) => ({ ...entry, space: entry.space === undefined ? undefined : spaceName(entry.space) }))),
    delegate: async (_audience, entries): Promise<SpaceGrant> => {
      delegated.push(...entries);
      return { spaceId: entries[0].space!, cid: "cid", delegation: "wire", expiresAt: 1_000, prompted: false };
    },
    stepUp: async (_scopes, entries) => {
      stepUps.push(entries);
      return false;
    },
    missing: () => {},
    theme: () => "dark",
  };
  const embed = new EmbedHost(deps);
  const send = (data: unknown) => embed.handle({ origin: app.origin, source: frame, data });
  const hello = { v: 1, type: "tc-embed/hello", appId: app.id, sessionDid: `did:key:${KEY}#${KEY}`, nonce: "nonce-hello-000001" };
  return { posted, delegated, stepUps, send, hello };
}

describe("framed apps on the narrowed session", () => {
  test("the Ledger frame is delegated its whole ceiling with no prompt", async () => {
    const { tcw } = await signIn();
    const ledger = framedApp(LEDGER_ID)!;
    const run = host(ledger, tcw);
    await run.send(run.hello);
    expect(run.stepUps).toEqual([]);
    expect(run.delegated.length).toBe(ledger.ceiling(OWNER).length);
  });

  test("Explorer's all-apps KV read is no longer held, so the frame's request asks (step-up)", async () => {
    const { tcw } = await signIn();
    const explorer = framedApp(EXPLORER_ID)!;
    const run = host(explorer, tcw);
    await run.send(run.hello);
    await run.send({ v: 1, type: "tc-embed/request", nonce: "nonce-request-00001", permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["get", "list"] }] });
    expect(run.stepUps).toHaveLength(1);
    expect(run.stepUps[0]!.map(({ service, path, actions }) => ({ service, path, actions }))).toEqual([{ service: "tinycloud.kv", path: "", actions: ["get", "list"] }]);
    // Refused at the prompt: the frame is told, and nothing wider than the ceiling was delegated.
    expect(run.posted.some((message) => message.type === "tc-embed/denied")).toBe(true);
  });
});
