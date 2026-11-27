// Account erase (TC-4416), the supervisor's half: one signed route removes everything the bots service holds for an
// owner, Main included, and writes nothing for them anywhere. The product rule that a user cannot delete Main is untouched.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAsksEnabled } from "../asks";
import { Bot, BotManager, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import { HistoryJournal } from "../history";
import { botLayout, type LayoutRoots } from "../layout";
import { OwnerManifests } from "../manifest";
import { botIdFor } from "../owner";
import type { Frame } from "../rpc";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const tmp = mkdtempSync(join(tmpdir(), "erase-owner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => { for (const spy of spies) spy.mockRestore(); spies.length = 0; });
const spies: Array<{ mockRestore(): void }> = [];

const SERVICE_VALUE = "s".repeat(64);
const OWNER = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
const OTHER = `did:pkh:eip155:1:0x${"33".repeat(20)}`;
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);
const HISTORY = { signerDid: `did:pkh:eip155:1:0x${"11".repeat(20)}`, host: "https://node.test", policy: "notice-then-expiry-30-days" as const };
const OPTIONS = { idleMs: 60_000, turnTimeoutMs: 5_000, maxTurnBytes: 1024, history: HISTORY };

class RunningSandbox implements Sandbox {
  stops = 0;
  readonly #exit = Promise.withResolvers<void>();
  readonly exited = this.#exit.promise;
  readonly prompted = Promise.withResolvers<void>();
  nextId = () => "p-1";
  async request(command: Record<string, unknown>) { if (command.type === "prompt") this.prompted.resolve(); return { agentInvoked: true }; }
  onFrame(_listener: (frame: Frame) => void) { return () => {}; }
  async refreshEgress() {}
  async snapshot() {}
  async stop() { this.stops++; this.#exit.resolve(); }
}

function setup(accounts: Set<string> | "*" = "*", launcherOverrides: Partial<SandboxLauncher> = {}) {
  const root = mkdtempSync(join(tmp, "case-"));
  const roots: LayoutRoots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const gateway: Array<{ owner: string; keys: readonly string[] }> = [];
  const sandbox = new RunningSandbox();
  const launcher: SandboxLauncher = {
    hasState: () => true,
    leftover: () => false,
    mountPoints: () => [],
    launch: async () => sandbox,
    eraseOwner: async (owner, keys) => { gateway.push({ owner, keys }); },
    ...launcherOverrides,
  };
  const manifest = new OwnerManifests(join(roots.dataRoot, "owners"));
  const bots = new BotManager(launcher, roots, OPTIONS, 3);
  const app = createApp({ secret: SERVICE_VALUE, accounts, bots, manifest, acceptLegacyOwnerHeader: false });
  const call = (owner: string, method: string, path: string, init: { bot?: string; body?: string; secret?: string } = {}) => {
    const authorization = signedCallHeader(init.secret ?? SERVICE_VALUE, {
      direction: "to-service", environment: "private", owner, bot: init.bot ?? /^\/v1\/bots\/([^/?]+)/.exec(path)![1]!, method, path: path.split("?")[0]! + (path.includes("?") ? `?${path.split("?")[1]}` : ""),
      body: init.body === undefined ? undefined : new TextEncoder().encode(init.body),
    });
    return app(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization }, body: init.body }));
  };
  const erase = (owner: string) => call(owner, "POST", "/v1/bots/main/erase");
  const manifestFile = (owner: string) => join(roots.dataRoot, "owners", `${botIdFor(owner)}.json`);
  /** What an account that used Main and one sibling leaves on this host. */
  function populate(owner: string, key = KEY_A) {
    manifest.announce(owner, key, "active", 1);
    const layouts = [bots.forOwner(owner).layout, bots.forBot(owner, key).layout];
    for (const layout of layouts) {
      mkdirSync(layout.stateSnapshot, { recursive: true });
      mkdirSync(layout.bundleDir, { recursive: true });
      writeFileSync(join(layout.stateSnapshot, "session"), "conversation text");
      writeFileSync(join(layout.bundleDir, "config.json"), "{}");
      writeFileSync(layout.lastUsedFile, new Date().toISOString());
      writeFileSync(`${layout.dataDir}.history-revocation.json`, "{}");
      const journal = new HistoryJournal(layout, HISTORY);
      journal.begin(owner, 1000);
      journal.append({ type: "user", text: "not archived yet" });
      journal.permissionActive(Date.now() + 3_600_000);
    }
    return layouts;
  }
  const traces = (layout: { dataDir: string; bundleDir: string }) =>
    [layout.dataDir, layout.bundleDir, `${layout.dataDir}.history-revocation.json`].filter(existsSync);
  return { roots, bots, manifest, manifestFile, call, erase, populate, traces, gateway, sandbox };
}

describe("the erase route", () => {
  test("removes Main, every sibling, the manifest and the revocation markers, and nobody else's", async () => {
    const { bots, erase, populate, traces, manifestFile, gateway } = setup();
    const mine = populate(OWNER);
    const theirs = populate(OTHER);
    expect(mine.flatMap(traces)).toHaveLength(6);
    const response = await erase(OWNER);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "gone" });
    expect(mine.flatMap(traces)).toEqual([]);
    expect(existsSync(manifestFile(OWNER))).toBe(false);
    expect(gateway).toEqual([{ owner: OWNER, keys: [KEY_A] }]);
    // The other owner's three kinds of files are as they were, and so is their manifest.
    expect(theirs.flatMap(traces)).toHaveLength(6);
    expect(existsSync(manifestFile(OTHER))).toBe(true);
    expect(bots.forOwner(OTHER).layout.dataDir).toBe(theirs[0]!.dataDir);
  });

  test("repeating it answers gone, also for an owner that never had anything, and creates nothing", async () => {
    const { roots, erase, populate } = setup();
    populate(OWNER);
    expect((await (await erase(OWNER)).json())).toEqual({ outcome: "gone" });
    expect((await (await erase(OWNER)).json())).toEqual({ outcome: "gone" });
    const never = setup();
    const response = await never.erase(OTHER);
    expect(await response.json()).toEqual({ outcome: "gone" });
    expect(existsSync(never.roots.dataRoot)).toBe(false);
    expect(existsSync(never.roots.runRoot)).toBe(false);
    expect(readdirSync(roots.dataRoot).sort()).toEqual(["owners"]);
  });

  test("history that was never archived is dropped: neither the archive check nor the receipt check runs", async () => {
    const { bots, erase, populate, traces } = setup();
    const layouts = populate(OWNER);
    populate(OTHER);
    // The same history on a normal deletion waits for the archive.
    expect(await bots.deleteBot(OTHER, KEY_A)).toBe("archive_pending");
    const covered = spyOn(Bot.prototype, "historyCovered");
    const coverage = spyOn(HistoryJournal.prototype, "verifyCoverage");
    spies.push(covered, coverage);
    expect(await (await erase(OWNER)).json()).toEqual({ outcome: "gone" });
    expect(layouts.flatMap(traces)).toEqual([]);
    expect(covered).not.toHaveBeenCalled();
    expect(coverage).not.toHaveBeenCalled();
  });

  test("it puts nothing back: no questions setting, no web or read setting, no journal", async () => {
    const { erase, populate, traces } = setup();
    const layouts = populate(OWNER);
    writeAsksEnabled(layouts[0]!, false);
    expect(await (await erase(OWNER)).json()).toEqual({ outcome: "gone" });
    expect(layouts.flatMap(traces)).toEqual([]);
  });

  test("a running sandbox is stopped and the turn in flight ends before anything is removed", async () => {
    const { bots, erase, populate, traces, sandbox } = setup();
    const [main] = populate(OWNER);
    const events: string[] = [];
    const sink: TurnSink = { status: () => {}, delta: () => {}, done: () => events.push("done"), error: code => events.push(code) };
    const turn = bots.forOwner(OWNER).send("a question", sink, OWNER);
    await sandbox.prompted.promise;
    expect(await (await erase(OWNER)).json()).toEqual({ outcome: "gone" });
    await turn;
    expect(sandbox.stops).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(["bot_unavailable"]);
    expect(traces(main!)).toEqual([]);
  });

  test("a request that arrives during the erase is refused and leaves no directory behind", async () => {
    const { bots, erase, populate, traces } = setup();
    const [main] = populate(OWNER);
    const pending = erase(OWNER);
    const events: string[] = [];
    await bots.forOwner(OWNER).send("late", { status: () => {}, delta: () => {}, done: () => events.push("done"), error: code => events.push(code) }, OWNER);
    expect(events).toEqual(["bot_unavailable"]);
    expect(await (await pending).json()).toEqual({ outcome: "gone" });
    expect(traces(main!)).toEqual([]);
  });

  test("an owner that signs up again afterwards starts a fresh Main", async () => {
    const { bots, erase, populate } = setup();
    populate(OWNER);
    const first = bots.forOwner(OWNER);
    await erase(OWNER);
    expect(bots.forOwner(OWNER)).not.toBe(first);
  });
});

describe("what the route accepts", () => {
  test("an owner that is not on the account list can be erased; the same owner cannot use Main", async () => {
    const { call, populate, traces } = setup(new Set(["0x" + "22".repeat(20)]));
    const [main] = populate(OTHER);
    expect((await call(OTHER, "GET", "/v1/bots/main/messages")).status).toBe(401);
    const response = await call(OTHER, "POST", "/v1/bots/main/erase");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "gone" });
    expect(traces(main!)).toEqual([]);
  });

  test("the owner is the signature's alone: a signature for one owner erases that owner and no other", async () => {
    const { erase, populate, traces, gateway } = setup();
    const mine = populate(OWNER);
    const theirs = populate(OTHER);
    await erase(OTHER);
    expect(theirs.flatMap(traces)).toEqual([]);
    expect(mine.flatMap(traces)).toHaveLength(6);
    expect(gateway.map(call => call.owner)).toEqual([OTHER]);
  });

  test("a signature that is wrong, made for another bot, another path or another method, or an unsigned call, is refused and erases nothing", async () => {
    const { call, populate, traces, gateway, roots } = setup();
    const layouts = populate(OWNER);
    const url = "http://127.0.0.1/v1/bots/main/erase";
    const header = (path: string, method: string, bot: string, secret = SERVICE_VALUE) =>
      signedCallHeader(secret, { direction: "to-service", environment: "private", owner: OWNER, bot, method, path });
    const app = createApp({ secret: SERVICE_VALUE, accounts: "*", bots: new BotManager({ hasState: () => true, leftover: () => false, launch: async () => { throw new Error("no"); } }, roots, OPTIONS, 3), acceptLegacyOwnerHeader: false });
    const refused = await Promise.all([
      app(new Request(url, { method: "POST", headers: { authorization: header("/v1/bots/main/erase", "POST", "main", "x".repeat(64)) } })),
      app(new Request(url, { method: "POST", headers: { authorization: header("/v1/bots/main/erase", "POST", KEY_A) } })),
      app(new Request(url, { method: "POST", headers: { authorization: header("/v1/bots/main", "DELETE", "main") } })),
      app(new Request(url, { method: "POST", headers: { authorization: header("/v1/bots/main/new-chat", "POST", "main") } })),
      app(new Request(url, { method: "POST" })),
      app(new Request(url, { method: "POST", headers: { authorization: `Bearer ${SERVICE_VALUE}`, "x-tinycloud-owner": OWNER } })),
      call(OWNER, "POST", `/v1/bots/${KEY_A}/erase`),
    ]);
    expect(refused.map(response => response.status)).toEqual([401, 401, 401, 401, 401, 401, 404]);
    expect(layouts.flatMap(traces)).toHaveLength(6);
    expect(gateway).toEqual([]);
  });

  test("the legacy bearer is refused even when the legacy owner header is accepted", async () => {
    const { roots, bots, populate, traces } = setup();
    const layouts = populate(OWNER);
    const app = createApp({ secret: SERVICE_VALUE, accounts: "*", bots, acceptLegacyOwnerHeader: true });
    const response = await app(new Request("http://127.0.0.1/v1/bots/main/erase", { method: "POST", headers: { authorization: `Bearer ${SERVICE_VALUE}`, "x-tinycloud-owner": OWNER } }));
    expect(response.status).toBe(401);
    expect(layouts.flatMap(traces)).toHaveLength(6);
    expect(existsSync(roots.dataRoot)).toBe(true);
  });

  test("a body or a query string is refused: the signed request is empty", async () => {
    const { call, populate, traces } = setup();
    const layouts = populate(OWNER);
    const withBody = await call(OWNER, "POST", "/v1/bots/main/erase", { body: JSON.stringify({ owner: OTHER }) });
    const withQuery = await call(OWNER, "POST", "/v1/bots/main/erase?owner=other");
    expect([withBody.status, withQuery.status]).toEqual([400, 400]);
    expect(await withBody.json()).toEqual({ outcome: "failed", cause: "invalid" });
    expect(layouts.flatMap(traces)).toHaveLength(6);
  });

  test("a replayed signature is refused", async () => {
    const { roots, bots } = setup();
    const app = createApp({ secret: SERVICE_VALUE, accounts: "*", bots, manifest: new OwnerManifests(join(roots.dataRoot, "owners")), acceptLegacyOwnerHeader: false });
    const authorization = signedCallHeader(SERVICE_VALUE, { direction: "to-service", environment: "private", owner: OWNER, bot: "main", method: "POST", path: "/v1/bots/main/erase" });
    const send = () => app(new Request("http://127.0.0.1/v1/bots/main/erase", { method: "POST", headers: { authorization } }));
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
  });
});

describe("answers that are not gone", () => {
  test("a gateway that cannot erase is pending, keeps the manifest, and the retry finishes", async () => {
    let fail = true;
    const { erase, populate, traces, manifestFile } = setup("*", { eraseOwner: async () => { if (fail) throw new Error("sensitive detail"); } });
    const layouts = populate(OWNER);
    const first = await erase(OWNER);
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ outcome: "pending", cause: "gateway_erase_failed" });
    // The files here are gone, the manifest that names the siblings stays for the retry.
    expect(layouts.flatMap(traces)).toEqual([]);
    expect(existsSync(manifestFile(OWNER))).toBe(true);
    fail = false;
    expect(await (await erase(OWNER)).json()).toEqual({ outcome: "gone" });
    expect(existsSync(manifestFile(OWNER))).toBe(false);
  });

  test("a teardown that is not confirmed is pending and removes nothing", async () => {
    const { erase, populate, traces, manifestFile, gateway } = setup("*", { leftover: () => true });
    const layouts = populate(OWNER);
    const response = await erase(OWNER);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "pending", cause: "teardown_failed" });
    expect(layouts.flatMap(traces)).toHaveLength(6);
    expect(existsSync(manifestFile(OWNER))).toBe(true);
    expect(gateway).toEqual([]);
  });

  test("a runtime that cannot erase the gateway answers failed, never gone", async () => {
    const { erase, populate, manifestFile } = setup("*", { eraseOwner: undefined });
    populate(OWNER);
    const response = await erase(OWNER);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "failed", cause: "unsupported" });
    expect(existsSync(manifestFile(OWNER))).toBe(true);
  });

  test("a manifest that cannot be read fails the erase and removes nothing", async () => {
    const { erase, populate, traces, manifestFile } = setup();
    const layouts = populate(OWNER);
    writeFileSync(manifestFile(OWNER), "not json");
    const response = await erase(OWNER);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "failed", cause: "error" });
    expect(layouts.flatMap(traces)).toHaveLength(6);
  });

  test("no answer or log line carries the owner, a bot key or any conversation text", async () => {
    const lines: string[] = [];
    spies.push(spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); }));
    const { erase, populate } = setup("*", { eraseOwner: async () => { throw new Error(`failed for ${OWNER}`); } });
    populate(OWNER);
    const text = await (await erase(OWNER)).text();
    expect(lines.length).toBeGreaterThan(0);
    const all = [text, ...lines].join("\n");
    for (const secret of [OWNER, OWNER.slice(-40), KEY_A, "conversation text", "not archived yet", botIdFor(OWNER), botIdFor(OWNER, KEY_A)]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("Main is still not deletable by a user", () => {
  test("DELETE /v1/bots/main is refused and PUT state deleting for main is rejected", async () => {
    const { call, populate, traces, manifest, manifestFile } = setup();
    const layouts = populate(OWNER);
    const deleted = await call(OWNER, "DELETE", "/v1/bots/main");
    expect(deleted.status).toBe(405);
    const body = JSON.stringify({ state: "deleting", updatedAt: 2 });
    const announced = await call(OWNER, "PUT", "/v1/bots/main", { body });
    expect(announced.status).toBe(400);
    expect(manifest.stateOf(OWNER, "main")).toBe("active");
    expect(layouts.flatMap(traces)).toHaveLength(6);
    expect(existsSync(manifestFile(OWNER))).toBe(true);
  });

  test("the erase route does not widen sibling deletion: a sibling still goes by its own state", async () => {
    const { call, populate, manifest } = setup();
    populate(OWNER, KEY_B);
    expect((await call(OWNER, "DELETE", `/v1/bots/${KEY_B}`)).status).not.toBe(200);
    expect(manifest.stateOf(OWNER, KEY_B)).toBe("active");
  });
});

