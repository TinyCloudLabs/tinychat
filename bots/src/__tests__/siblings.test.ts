// More than one bot per owner (TC-3325): ids, the owner manifest, a journal bound to its bot, what each state
// allows, and deletion's three answers.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { BotManager, type ListedMessage, type SandboxLauncher, type TurnSink } from "../bot";
import { HistoryJournal } from "../history";
import { botLayout, type LayoutRoots } from "../layout";
import { OwnerManifests } from "../manifest";
import { botIdFor } from "../owner";
import type { DeleteSkip } from "../retention";
import { type BotApi, createApp } from "../server";

const tmp = mkdtempSync(join(tmpdir(), "bot-siblings-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const OWNER = "did:pkh:eip155:1:0x" + "22".repeat(20);
const OTHER = "did:pkh:eip155:1:0x" + "33".repeat(20);
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function roots(): LayoutRoots {
  const root = mkdtempSync(join(tmp, "case-"));
  return { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
}

describe("bot ids", () => {
  test("Main's id is what it always was, byte for byte, with or without the key", () => {
    expect(botIdFor(OWNER)).toBe("11db6cc2930810ec2e88a86f05026feb734250c7b9afbd5914a6a82955e32136");
    expect(botIdFor(OWNER, "main")).toBe(botIdFor(OWNER));
  });

  test("a sibling's id is the hash of the owner, a newline and its key", () => {
    expect(botIdFor(OWNER, KEY_A)).toBe("c3b8444e14bf08dc624dfd314fb3a4746688b5970324a4dc3f65e10390683643");
    expect(botIdFor(OWNER, KEY_A)).not.toBe(botIdFor(OWNER, KEY_B));
    expect(botIdFor(OWNER, KEY_A)).not.toBe(botIdFor(OTHER, KEY_A));
  });

  test("a key that is not 32 lower-case hex characters never reaches the hash", () => {
    for (const key of ["", "MAIN", "ab".repeat(15), "AB".repeat(16), `${"ab".repeat(15)}/x`, "../../etc", `${KEY_A}\n`]) {
      expect(() => botIdFor(OWNER, key)).toThrow("invalid bot key");
    }
  });
});

describe("owner manifest", () => {
  const manifests = () => new OwnerManifests(join(mkdtempSync(join(tmp, "manifest-")), "owners"));

  test("Main is active without being announced; a sibling does not exist until it is", () => {
    const manifest = manifests();
    expect(manifest.stateOf(OWNER, "main")).toBe("active");
    expect(manifest.stateOf(OWNER, KEY_A)).toBeUndefined();
    expect(manifest.announce(OWNER, KEY_A, "active", 1)).toBe("active");
    expect(manifest.stateOf(OWNER, KEY_A)).toBe("active");
    expect(manifest.stateOf(OTHER, KEY_A)).toBeUndefined();
  });

  test("an update older than the one held is ignored, and the state survives a restart", () => {
    const root = join(mkdtempSync(join(tmp, "manifest-")), "owners");
    const manifest = new OwnerManifests(root);
    manifest.announce(OWNER, KEY_A, "active", 5);
    expect(manifest.announce(OWNER, KEY_A, "suspended", 7)).toBe("suspended");
    expect(manifest.announce(OWNER, KEY_A, "active", 6)).toBe("suspended");
    expect(manifest.announce(OWNER, KEY_A, "active", 7)).toBe("suspended");
    expect(new OwnerManifests(root).stateOf(OWNER, KEY_A)).toBe("suspended");
  });

  test("deleting is final: a later active does not reopen the bot, and only a deleting bot can be removed", () => {
    const manifest = manifests();
    manifest.announce(OWNER, KEY_A, "active", 1);
    manifest.markRemoved(OWNER, KEY_A);
    expect(manifest.stateOf(OWNER, KEY_A)).toBe("active");
    expect(manifest.announce(OWNER, KEY_A, "deleting", 2)).toBe("deleting");
    expect(manifest.announce(OWNER, KEY_A, "active", 9)).toBe("deleting");
    manifest.markRemoved(OWNER, KEY_A);
    expect(manifest.stateOf(OWNER, KEY_A)).toBe("removed");
    expect(manifest.announce(OWNER, KEY_A, "active", 10)).toBe("removed");
  });

  test("Main can be suspended and resumed but never deleted", () => {
    const manifest = manifests();
    expect(manifest.announce(OWNER, "main", "suspended", 1)).toBe("suspended");
    expect(manifest.announce(OWNER, "main", "active", 2)).toBe("active");
    expect(() => manifest.announce(OWNER, "main", "deleting", 3)).toThrow();
  });

  test("a manifest file that names another owner is refused", () => {
    const root = join(mkdtempSync(join(tmp, "manifest-")), "owners");
    const manifest = new OwnerManifests(root);
    manifest.announce(OTHER, KEY_A, "active", 1);
    copyFileSync(join(root, `${botIdFor(OTHER)}.json`), join(root, `${botIdFor(OWNER)}.json`));
    expect(() => manifest.stateOf(OWNER, KEY_A)).toThrow("invalid_manifest");
  });
});

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const HISTORY = { signerDid: `did:pkh:eip155:1:${account.address.toLowerCase()}`, host: "https://node.test", policy: "notice-then-expiry-30-days" as const };

async function receipt(journal: HistoryJournal, botId: string, extra: Record<string, unknown>) {
  const batch = journal.pending()!;
  const body = {
    v: 1, owner: OWNER, botId, generation: batch.generation, seq: batch.seq, challenge: batch.challenge,
    batchHash: sha256(JSON.stringify(batch)), spaceId: `tinycloud:pkh:eip155:1:0x${"22".repeat(20)}:applications`, host: HISTORY.host,
    ciphertextHash: "a".repeat(64), ...extra,
  };
  return { body, signature: await account.signMessage({ message: `tinychat.bot-history.storage/v1\n${JSON.stringify(body)}` }) };
}

describe("a sibling's journal", () => {
  function sibling(key = KEY_A, at = roots()) {
    const layout = botLayout(botIdFor(OWNER, key), at, { botKey: key, ownerId: botIdFor(OWNER) });
    return { layout, journal: new HistoryJournal(layout, HISTORY), at };
  }
  const pathOf = (journal: HistoryJournal, botId: string) => {
    const batch = journal.pending()!;
    return `xyz.tinycloud.tinychat/threads/bots/v1/${botId}/${batch.generation}/${batch.seq}-${batch.challenge}`;
  };

  test("its batches carry its key, and Main's carry none", () => {
    const { journal } = sibling();
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    expect(journal.pending()).toMatchObject({ seq: 1, bot: KEY_A });
    const main = new HistoryJournal(botLayout(botIdFor(OWNER), roots()), HISTORY);
    main.begin(OWNER, 1000);
    main.append({ type: "user", text: "hello" });
    expect(Object.keys(main.pending()!)).toEqual(["v", "generation", "seq", "challenge", "record"]);
  });

  test("it only begins for its own owner", () => {
    const { journal } = sibling();
    expect(() => journal.begin(OTHER, 1000)).toThrow("history_owner_mismatch");
    journal.begin(OWNER, 1000);
  });

  test("after a restart it is found by its directory alone and still checks out", () => {
    const { layout, journal, at } = sibling();
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    const found = new HistoryJournal(botLayout(layout.botId, at), HISTORY);
    expect(found.pending()).toMatchObject({ seq: 1, bot: KEY_A });
    // The same file under another sibling's directory, or opened as another key, is refused.
    const other = botLayout(botIdFor(OWNER, KEY_B), at, { botKey: KEY_B, ownerId: botIdFor(OWNER) });
    mkdirSync(other.dataDir, { recursive: true });
    copyFileSync(join(layout.dataDir, "history.json"), join(other.dataDir, "history.json"));
    expect(() => new HistoryJournal(other, HISTORY)).toThrow("invalid_history_journal");
    expect(() => new HistoryJournal(botLayout(other.botId, at), HISTORY)).toThrow("invalid_history_journal");
    expect(() => new HistoryJournal({ ...layout, botKey: KEY_B }, HISTORY)).toThrow("invalid_history_journal");
  });

  test("a journal whose batch names another bot is refused on load", () => {
    const { layout, journal } = sibling();
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    const file = join(layout.dataDir, "history.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.batches[0].bot = KEY_B;
    writeFileSync(file, JSON.stringify(state));
    expect(() => new HistoryJournal(layout, HISTORY)).toThrow("invalid_history_journal");
  });

  test("its receipt must name the bot, its key and the exact path written", async () => {
    const { layout, journal } = sibling();
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    const path = pathOf(journal, layout.botId);
    // Main's id, no key, no path, another sibling's key, or a path in another bot's directory: each is refused.
    for (const [botId, extra] of [
      [botIdFor(OWNER), { key: KEY_A, path }],
      [layout.botId, {}],
      [layout.botId, { key: KEY_A }],
      [layout.botId, { key: KEY_B, path }],
      [layout.botId, { key: KEY_A, path: pathOf(journal, botIdFor(OWNER, KEY_B)) }],
      [layout.botId, { key: KEY_A, path: pathOf(journal, botIdFor(OWNER)) }],
    ] as const) {
      await expect(journal.accept(await receipt(journal, botId, extra))).rejects.toThrow("invalid_history_receipt");
    }
    await journal.accept(await receipt(journal, layout.botId, { key: KEY_A, path }));
    expect(await journal.verifyCoverage()).toBe(true);
  });

  test("a receipt made for one sibling is refused by another", async () => {
    const a = sibling(KEY_A);
    const b = sibling(KEY_B);
    for (const { journal } of [a, b]) {
      journal.begin(OWNER, 1000);
      journal.append({ type: "user", text: "hello" });
    }
    const forA = await receipt(a.journal, a.layout.botId, { key: KEY_A, path: pathOf(a.journal, a.layout.botId) });
    await expect(b.journal.accept(forA)).rejects.toThrow("invalid_history_receipt");
  });
});

const launcher: SandboxLauncher = {
  hasState: () => false,
  leftover: () => false,
  mountPoints: () => [],
  launch: async () => { throw new Error("not used"); },
};
const OPTIONS = { idleMs: 1000, turnTimeoutMs: 1000, maxTurnBytes: 1024 };

describe("the manager's bots", () => {
  test("Main and two siblings are three bots with their own directories, totalled under one owner", () => {
    const manager = new BotManager(launcher, roots(), OPTIONS, 3);
    const main = manager.forOwner(OWNER);
    const a = manager.forBot(OWNER, KEY_A);
    const b = manager.forBot(OWNER, KEY_B);
    expect(manager.forBot(OWNER, "main")).toBe(main);
    expect(manager.forBot(OWNER, KEY_A)).toBe(a);
    expect(new Set([main.layout.dataDir, a.layout.dataDir, b.layout.dataDir]).size).toBe(3);
    expect(main.layout).toMatchObject({ botId: botIdFor(OWNER), ownerId: botIdFor(OWNER) });
    expect(main.layout.botKey).toBeUndefined();
    expect(a.layout).toMatchObject({ botId: botIdFor(OWNER, KEY_A), botKey: KEY_A, ownerId: botIdFor(OWNER) });
    expect(manager.forBot(OTHER, KEY_A).layout.ownerId).toBe(botIdFor(OTHER));
  });

  test("a change of permission makes no journal and no directory for a sibling that has never run", async () => {
    const at = roots();
    const manager = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    const bot = manager.forBot(OWNER, KEY_A);
    await bot.historyPermission(OWNER, undefined, Date.now() + 60_000);
    await bot.historyPermission(OWNER, Date.now() - 1000);
    expect(existsSync(bot.layout.dataDir)).toBe(false);
    expect(existsSync(at.dataRoot)).toBe(false);
  });

  test("a sibling that has run takes a change of permission like Main does", async () => {
    const manager = new BotManager(launcher, roots(), { ...OPTIONS, history: HISTORY }, 3);
    const bot = manager.forBot(OWNER, KEY_A);
    const journal = new HistoryJournal(bot.layout, HISTORY);
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    const expiry = Date.now() - 1000;
    await bot.historyPermission(OWNER, expiry);
    expect(await bot.historyNotice()).toMatchObject({ expiresAt: expiry });
  });

  test("deleting a sibling that never ran is done at once and creates nothing", async () => {
    const at = roots();
    const manager = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    expect(await manager.deleteBot(OWNER, KEY_A)).toBeUndefined();
    expect(existsSync(at.dataRoot)).toBe(false);
  });

  test("deleting a sibling waits while its history is unsaved, across a restart, and goes once the receipt is in", async () => {
    const at = roots();
    const first = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    const layout = first.forBot(OWNER, KEY_A).layout;
    const journal = new HistoryJournal(layout, HISTORY);
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    expect(await first.deleteBot(OWNER, KEY_A)).toBe("archive_pending");
    // A new process finds the same bot and gives the same answer.
    const second = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    expect(await second.deleteBot(OWNER, KEY_A)).toBe("archive_pending");
    const batch = journal.pending()!;
    const path = `xyz.tinycloud.tinychat/threads/bots/v1/${layout.botId}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    await second.forBot(OWNER, KEY_A).historyReceipt(await receipt(journal, layout.botId, { key: KEY_A, path }));
    expect(await second.deleteBot(OWNER, KEY_A)).toBeUndefined();
    expect(existsSync(layout.dataDir)).toBe(false);
  });

  test("a sibling whose permission expired and whose notice ran out is deleted without a receipt", async () => {
    const at = roots();
    const manager = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    const bot = manager.forBot(OWNER, KEY_A);
    const journal = new HistoryJournal(bot.layout, HISTORY);
    const day = 86_400_000;
    const expiry = Date.now() - 40 * day;
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    journal.permissionExpired(expiry, OWNER, expiry);
    expect(await manager.deleteBot(OWNER, KEY_A)).toBe("archive_pending");
    const notice = journal.notice()!;
    journal.acknowledgeNotice(notice.id, expiry + day, expiry + day);
    const restarted = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    expect(await restarted.deleteBot(OWNER, KEY_A)).toBeUndefined();
    expect(existsSync(bot.layout.dataDir)).toBe(false);
  });
});

const SECRET = "s".repeat(64);
const headers = { authorization: `Bearer ${SECRET}`, "x-tinycloud-owner": OWNER };
const url = (key: string, rest = "") => `http://bots.internal/v1/bots/${key}${rest}`;

function service(deleteBot: () => Promise<DeleteSkip | undefined> = async () => undefined) {
  const reached: string[] = [];
  const deleted: string[] = [];
  const bot = (name: string): BotApi => ({
    send: async (_text: string, sink: TurnSink) => { reached.push(`${name}:send`); sink.done("b-1"); },
    list: async (): Promise<ListedMessage[]> => { reached.push(`${name}:list`); return []; },
    historyPending: async () => { reached.push(`${name}:pending`); return undefined; },
    historyNotice: async () => { reached.push(`${name}:notice`); return undefined; },
    historyPermission: async () => { reached.push(`${name}:permission`); },
  });
  const manifest = new OwnerManifests(join(mkdtempSync(join(tmp, "service-")), "owners"));
  const app = createApp({
    secret: SECRET,
    accounts: "*",
    manifest,
    bots: {
      forOwner: () => bot("main"),
      forBot: (_owner, key) => bot(key),
      deleteBot: async (_owner, key) => { deleted.push(key); return deleteBot(); },
    },
  });
  const call = (method: string, key: string, rest = "", body?: unknown) =>
    app(new Request(url(key, rest), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { app, call, manifest, reached, deleted };
}

describe("the service's routes for several bots", () => {
  test("a key nobody announced, and a malformed one, get 404 before any bot is looked up", async () => {
    const { call, reached } = service();
    for (const key of [KEY_A, "AB".repeat(16), "ab".repeat(15), "main2", "..%2f..%2fmain"]) {
      for (const [method, rest] of [["POST", "/messages"], ["GET", "/messages"], ["GET", "/history"], ["PUT", "/history/permission"]] as const) {
        const res = await call(method, key, rest, method === "GET" ? undefined : { text: "hi" });
        expect(res.status).toBe(404);
      }
    }
    expect(reached).toEqual([]);
  });

  test("Main works as before with a manifest in place", async () => {
    const { call, reached } = service();
    expect((await call("GET", "main", "/messages")).status).toBe(200);
    expect((await (await call("POST", "main", "/messages", { text: "hi" })).text())).toContain("event: done");
    expect(reached).toEqual(["main:list", "main:send"]);
  });

  test("each state allows exactly what it should", async () => {
    const { call, manifest, reached } = service();
    const attempt = async () => ({
      turn: (await call("POST", KEY_A, "/messages", { text: "hi" })).status,
      read: (await call("GET", KEY_A, "/messages")).status,
      history: (await call("GET", KEY_A, "/history")).status,
      notice: (await call("GET", KEY_A, "/history/notice")).status,
      permission: (await call("PUT", KEY_A, "/history/permission", { validUntil: Date.now() + 1000 })).status,
    });
    manifest.announce(OWNER, KEY_A, "active", 1);
    expect(await attempt()).toEqual({ turn: 200, read: 200, history: 200, notice: 200, permission: 204 });
    manifest.announce(OWNER, KEY_A, "suspended", 2);
    expect(await attempt()).toEqual({ turn: 409, read: 200, history: 200, notice: 200, permission: 204 });
    manifest.announce(OWNER, KEY_A, "deleting", 3);
    reached.length = 0;
    expect(await attempt()).toEqual({ turn: 409, read: 409, history: 200, notice: 200, permission: 204 });
    expect(reached).toEqual([`${KEY_A}:pending`, `${KEY_A}:notice`, `${KEY_A}:permission`]);
    manifest.markRemoved(OWNER, KEY_A);
    expect(await attempt()).toEqual({ turn: 404, read: 404, history: 404, notice: 404, permission: 404 });
  });

  test("a suspended Main takes no new turn but can still be read", async () => {
    const { call, manifest } = service();
    manifest.announce(OWNER, "main", "suspended", 1);
    expect((await call("POST", "main", "/messages", { text: "hi" })).status).toBe(409);
    expect((await call("GET", "main", "/messages")).status).toBe(200);
  });

  test("announcing a bot answers with the state now held: an older update and an active after deleting change nothing", async () => {
    const { call } = service();
    const announce = async (state: string, seq: number) => (await call("PUT", KEY_A, "", { state, seq })).json();
    expect(await announce("active", 4)).toEqual({ state: "active" });
    expect(await announce("suspended", 3)).toEqual({ state: "active" });
    expect(await announce("deleting", 5)).toEqual({ state: "deleting" });
    expect(await announce("active", 6)).toEqual({ state: "deleting" });
    for (const body of [{ state: "removed", seq: 7 }, { state: "active" }, { state: "active", seq: -1 }, { state: "active", seq: 1.5 }, "nonsense"]) {
      expect((await call("PUT", KEY_A, "", body)).status).toBe(400);
    }
    expect((await call("PUT", "main", "", { state: "deleting", seq: 1 })).status).toBe(400);
  });

  test("only a bot that is being deleted can be deleted, and never Main", async () => {
    const { call, manifest, deleted } = service();
    expect((await call("DELETE", KEY_A)).status).toBe(404);
    manifest.announce(OWNER, KEY_A, "active", 1);
    expect((await call("DELETE", KEY_A)).status).toBe(409);
    expect((await call("DELETE", "main")).status).toBe(405);
    expect(deleted).toEqual([]);
  });

  test("deletion answers gone, waiting or failed; gone is final", async () => {
    let cause: DeleteSkip | undefined = "archive_pending";
    const { call, manifest, deleted } = service(async () => cause);
    manifest.announce(OWNER, KEY_A, "deleting", 1);
    expect(await (await call("DELETE", KEY_A)).json()).toEqual({ outcome: "waiting", cause: "archive_pending" });
    cause = "closing";
    expect(await (await call("DELETE", KEY_A)).json()).toEqual({ outcome: "waiting", cause: "closing" });
    cause = "teardown_failed";
    expect(await (await call("DELETE", KEY_A)).json()).toEqual({ outcome: "failed", cause: "teardown_failed" });
    expect(manifest.stateOf(OWNER, KEY_A)).toBe("deleting");
    cause = undefined;
    expect(await (await call("DELETE", KEY_A)).json()).toEqual({ outcome: "gone" });
    expect(manifest.stateOf(OWNER, KEY_A)).toBe("removed");
    // Asked again, it is still gone, and nothing is deleted twice.
    expect(await (await call("DELETE", KEY_A)).json()).toEqual({ outcome: "gone" });
    expect(deleted).toHaveLength(4);
  });

  test("a permission update that races a deletion does not bring the bot's directory back", async () => {
    const at = roots();
    const manager = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    const manifest = new OwnerManifests(join(at.dataRoot, "owners"));
    const app = createApp({ secret: SECRET, accounts: "*", bots: manager, manifest });
    const bot = manager.forBot(OWNER, KEY_A);
    const layout = bot.layout;
    const journal = new HistoryJournal(layout, HISTORY);
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    const batch = journal.pending()!;
    const path = `xyz.tinycloud.tinychat/threads/bots/v1/${layout.botId}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    await journal.accept(await receipt(journal, layout.botId, { key: KEY_A, path }));
    manifest.announce(OWNER, KEY_A, "deleting", 1);
    const permission = () => app(new Request(url(KEY_A, "/history/permission"), { method: "PUT", headers, body: JSON.stringify({ validUntil: Date.now() + 60_000 }) }));
    const [deleted, raced] = await Promise.all([app(new Request(url(KEY_A), { method: "DELETE", headers })), permission()]);
    expect(await deleted.json()).toEqual({ outcome: "gone" });
    expect(existsSync(layout.dataDir)).toBe(false);
    // The update that lost the race is refused, not answered as if it had been applied.
    expect(raced.status).toBe(503);
    // Nothing reaches the bot afterwards either, through the service or directly.
    expect((await permission()).status).toBe(404);
    await expect(bot.historyPermission(OWNER, undefined, Date.now() + 60_000)).rejects.toThrow("bot_retired");
    await expect(bot.historyPending()).rejects.toThrow("bot_retired");
    await expect(bot.list()).rejects.toThrow("bot_retired");
    const events: string[] = [];
    await bot.send("hi", { status: () => {}, delta: () => {}, done: () => { events.push("done"); }, error: code => { events.push(code); } }, OWNER);
    expect(events).toEqual(["bot_unavailable"]);
    expect(existsSync(layout.dataDir)).toBe(false);
  });

  test("after an unused sibling's state is swept away, a permission update still makes no directory", async () => {
    const at = roots();
    const manager = new BotManager(launcher, at, { ...OPTIONS, history: HISTORY }, 3);
    const bot = manager.forBot(OWNER, KEY_A);
    const journal = new HistoryJournal(bot.layout, HISTORY);
    journal.begin(OWNER, 1000);
    journal.append({ type: "user", text: "hello" });
    const batch = journal.pending()!;
    const path = `xyz.tinycloud.tinychat/threads/bots/v1/${bot.layout.botId}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    await journal.accept(await receipt(journal, bot.layout.botId, { key: KEY_A, path }));
    const [cause] = await Promise.all([
      manager.deleteWorkingState(bot.layout.botId, "unused"),
      bot.historyPermission(OWNER, undefined, Date.now() + 60_000),
    ]);
    expect(cause).toBeUndefined();
    expect(existsSync(bot.layout.dataDir)).toBe(false);
  });
});
