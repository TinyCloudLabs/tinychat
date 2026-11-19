import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager } from "../bot";
import { supervisorConfig } from "../config";
import { OwnerManifests } from "../manifest";
import { RunscHost } from "../sandbox";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const OWNER = `did:pkh:eip155:1:0x${"12".repeat(20)}`;
const KEY = "ab".repeat(16);
const SERVICE_VALUE = "s".repeat(64);
const SAMPLE_OUTPUT = "gateway-test-output";
const OPTIONS = { idleMs: 60_000, turnTimeoutMs: 5000, maxTurnBytes: 512 };

function setup(root: string) {
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const host = new RunscHost(supervisorConfig({ BOTS_SERVICE_SECRET: SERVICE_VALUE, BOTS_EGRESS_ROOT: roots.egressRoot }));
  const manifest = new OwnerManifests(join(roots.dataRoot, "owners"));
  const bots = new BotManager(host, roots, OPTIONS, 3);
  const app = createApp({ secret: SERVICE_VALUE, accounts: "*", bots, manifest, acceptLegacyOwnerHeader: false });
  const call = (method: string, suffix = "") => {
    const path = `/v1/bots/${KEY}${suffix}`;
    const authorization = signedCallHeader(SERVICE_VALUE, { direction: "to-service", environment: "private", owner: OWNER, bot: KEY, method, path });
    return app(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization } }));
  };
  return { roots, host, bots, manifest, layout: bots.forBot(OWNER, KEY).layout, call };
}

test("deletion stays pending and finishes after a supervisor restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-del-"));
  const { roots, manifest, layout, call } = setup(root);
  const startedAt: number[] = [];
  let recovering = false;
  mkdirSync(layout.stateSnapshot, { recursive: true });
  mkdirSync(layout.bundleDir, { recursive: true });
  mkdirSync(layout.egressDir, { recursive: true });
  writeFileSync(join(layout.stateSnapshot, "session"), "sample session");
  writeFileSync(join(layout.bundleDir, "config.json"), "{}");
  writeFileSync(join(layout.egressDir, "sample"), SAMPLE_OUTPUT);
  const gateway = Bun.serve({
    unix: join(roots.egressRoot, "control.sock"),
    fetch(req) {
      if (req.method !== "DELETE" || new URL(req.url).pathname !== `/bots/${layout.botId}`) return new Response(null, { status: 404 });
      startedAt.push(performance.now());
      if (!recovering) return new Response(SAMPLE_OUTPUT, { status: 503 });
      if (startedAt.length === 5) rmSync(layout.egressDir, { recursive: true });
      return new Response(null, { status: 204 });
    },
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    manifest.announce(OWNER, KEY, "deleting", 1);
    const results = await Promise.all([call("DELETE"), call("DELETE")]);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ outcome: "waiting", cause: "gateway_cleanup_pending" });
    }
    expect(startedAt).toHaveLength(3);
    expect(startedAt[2]! - startedAt[0]!).toBeGreaterThanOrEqual(350);
    expect(manifest.stateOf(OWNER, KEY)).toBe("deleting");
    expect(existsSync(layout.dataDir)).toBe(true);
    expect(existsSync(layout.bundleDir)).toBe(true);
    expect(existsSync(layout.egressDir)).toBe(true);
    const output = log.mock.calls.map(([line]) => String(line));
    expect(output).toContain(JSON.stringify({ bots: "gateway_cleanup_pending", bot: layout.botId.slice(0, 12) }));
    expect(output.every(line => !line.includes(SAMPLE_OUTPUT))).toBe(true);

    recovering = true;
    const restarted = setup(root);
    expect(restarted.manifest.stateOf(OWNER, KEY)).toBe("deleting");
    const deleted = await restarted.call("DELETE");
    expect(await deleted.json()).toEqual({ outcome: "gone" });
    expect(startedAt).toHaveLength(5);
    expect(restarted.manifest.stateOf(OWNER, KEY)).toBe("removed");
    expect(existsSync(layout.dataDir)).toBe(false);
    expect(existsSync(layout.bundleDir)).toBe(false);
    expect(existsSync(layout.egressDir)).toBe(false);
  } finally {
    log.mockRestore();
    await gateway.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("deletion checks a bot's gateway directory even when its working files are absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-del-"));
  const { roots, manifest, layout, call } = setup(root);
  mkdirSync(layout.egressDir, { recursive: true });
  let attempts = 0;
  const gateway = Bun.serve({
    unix: join(roots.egressRoot, "control.sock"),
    fetch() {
      attempts++;
      rmSync(layout.egressDir, { recursive: true });
      return new Response(null, { status: 204 });
    },
  });
  try {
    manifest.announce(OWNER, KEY, "deleting", 1);
    expect(existsSync(layout.dataDir)).toBe(false);
    expect(existsSync(layout.bundleDir)).toBe(false);
    expect(await (await call("DELETE")).json()).toEqual({ outcome: "gone" });
    expect(attempts).toBe(1);
    expect(existsSync(layout.egressDir)).toBe(false);
    expect(await (await call("DELETE")).json()).toEqual({ outcome: "gone" });
    expect(attempts).toBe(1);
  } finally {
    await gateway.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("an incomplete sandbox stop keeps the deletion pending until the next request", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-del-"));
  const { host, bots, manifest, layout, call } = setup(root);
  const exit = Promise.withResolvers<void>();
  const launch = spyOn(host, "launch").mockResolvedValue({
    nextId: () => "list",
    request: async () => ({ messages: [] }),
    onFrame: () => () => {},
    exited: exit.promise,
    refreshEgress: async () => {},
    snapshot: async () => {},
    async stop() {
      exit.resolve();
      return "gateway_cleanup_pending";
    },
  });
  const cleanup = spyOn(host, "cleanupEgress").mockResolvedValue(true);
  try {
    mkdirSync(layout.stateSnapshot, { recursive: true });
    manifest.announce(OWNER, KEY, "active", 1);
    expect((await call("GET", "/messages")).status).toBe(200);
    expect(launch).toHaveBeenCalledTimes(1);
    manifest.announce(OWNER, KEY, "deleting", 2);
    expect(await (await call("DELETE")).json()).toEqual({ outcome: "waiting", cause: "gateway_cleanup_pending" });
    expect(cleanup).toHaveBeenCalledTimes(0);
    expect(existsSync(layout.dataDir)).toBe(true);

    expect(await (await call("DELETE")).json()).toEqual({ outcome: "gone" });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(layout.dataDir)).toBe(false);
  } finally {
    await bots.stopAll();
    launch.mockRestore();
    cleanup.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
