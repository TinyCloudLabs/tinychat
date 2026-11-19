import { expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { BotManager, type SandboxLauncher } from "../bot";
import { OwnerManifests } from "../manifest";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

function containsMarker(dir: string, markers: readonly string[]): boolean {
  return readdirSync(dir, { withFileTypes: true }).some(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return containsMarker(path, markers);
    if (!entry.isFile()) return false;
    const bytes = readFileSync(path);
    return markers.some(marker => bytes.includes(marker));
  });
}

test("deleting a bot stops its sandbox and removes its state and journal files", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-delete-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const address = `0x${"12".repeat(20)}`;
  const owner = `did:pkh:eip155:1:${address}`;
  const key = "ab".repeat(16);
  const secret = "s".repeat(64);
  const signer = privateKeyToAccount(`0x${"23".repeat(32)}`);
  const history = {
    signerDid: `did:pkh:eip155:1:${signer.address.toLowerCase()}`,
    host: "http://127.0.0.1:9499",
    policy: "notice-then-expiry-30-days" as const,
  };
  const markers = [`0x${randomBytes(32).toString("hex")}`, `test-delegation-${randomBytes(16).toString("hex")}`];
  let running = false;
  let stopped = 0;
  let stoppedWithFiles = false;
  const exit = Promise.withResolvers<void>();
  const launcher: SandboxLauncher = {
    leftover: () => running,
    hasState: layout => existsSync(layout.stateSnapshot),
    mountPoints: () => running ? [bot.layout.stateMount] : [],
    async launch() {
      running = true;
      return {
        nextId: () => "turn",
        request: async () => ({ agentInvoked: false }),
        onFrame: () => () => {},
        exited: exit.promise,
        refreshEgress: async () => {},
        snapshot: async () => {},
        async stop() {
          stoppedWithFiles = existsSync(bot.layout.stateSnapshot) && existsSync(bot.layout.stateMount);
          stopped++;
          running = false;
          exit.resolve();
        },
      };
    },
  };
  const manager = new BotManager(launcher, roots, { history, idleMs: 60_000, turnTimeoutMs: 5000, maxTurnBytes: 512 }, 3);
  const bot = manager.forBot(owner, key);
  const manifest = new OwnerManifests(join(roots.dataRoot, "owners"));
  const app = createApp({ secret, accounts: "*", bots: manager, manifest, acceptLegacyOwnerHeader: false });
  const call = (method: string, suffix = "", data?: unknown) => {
    const path = `/v1/bots/${key}${suffix}`;
    const body = data === undefined ? undefined : JSON.stringify(data);
    const authorization = signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot: key, method, path, body });
    return app(new Request(`http://127.0.0.1${path}`, { method, body, headers: { authorization } }));
  };
  const output: unknown[] = [];
  const logs = (["log", "warn", "error"] as const).map(level => spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args); }));
  try {
    expect((await call("PUT", "", { state: "active", seq: 1 })).status).toBe(200);
    expect(await (await call("POST", "/messages", { text: "example" })).text()).toContain("event: done");
    expect(running).toBe(true);
    for (const seq of [1, 2, 3]) {
      const batch = await bot.historyPending();
      expect(batch?.seq).toBe(seq);
      if (!batch) throw new Error("missing history batch");
      const batchHash = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
      const body = {
        v: 1, owner, botId: bot.layout.botId, generation: batch.generation, seq, challenge: batch.challenge,
        batchHash, spaceId: `tinycloud:pkh:eip155:1:${address}:applications`, host: history.host, ciphertextHash: "a".repeat(64),
        key, path: `xyz.tinycloud.tinychat/threads/bots/v1/${bot.layout.botId}/${batch.generation}/${seq}-${batch.challenge}`,
      };
      const signature = await signer.signMessage({ message: `tinychat.bot-history.storage/v1\n${JSON.stringify(body)}` });
      expect((await call("POST", "/history", { body, signature })).status).toBe(204);
    }
    expect((await call("PUT", "/history/permission", {
      validUntil: Date.now() + 60_000, privateKey: markers[0], delegation: markers[1],
    })).status).toBe(204);
    expect(containsMarker(root, markers)).toBe(false);

    // Put sample values in each per-bot file location before deletion.
    const planted = [
      join(bot.layout.stateSnapshot, "marker"), join(`${bot.layout.stateSnapshot}.new`, "marker"),
      join(`${bot.layout.stateSnapshot}.old`, "marker"), join(bot.layout.stateMount, "marker"),
      join(bot.layout.bundleDir, "config.json"), join(bot.layout.dataDir, "history.json.new"),
    ];
    for (const path of planted) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, markers.join("\n"));
    }
    expect(containsMarker(root, markers)).toBe(true);
    expect((await call("PUT", "", { state: "deleting", seq: 2 })).status).toBe(200);
    expect(await (await call("DELETE")).json()).toEqual({ outcome: "gone" });

    expect(stopped).toBe(1);
    expect(stoppedWithFiles).toBe(true);
    expect(running).toBe(false);
    expect(existsSync(bot.layout.dataDir)).toBe(false);
    expect(existsSync(bot.layout.bundleDir)).toBe(false);
    expect(containsMarker(root, markers)).toBe(false);
    expect((await call("PUT", "/history/permission", { validUntil: Date.now() + 60_000 })).status).toBe(404);
    expect(output.some(args => markers.some(marker => JSON.stringify(args).includes(marker)))).toBe(false);
  } finally {
    for (const log of logs) log.mockRestore();
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
