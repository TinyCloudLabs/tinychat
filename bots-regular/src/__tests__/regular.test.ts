import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { botIdFor } from "../../../bots/src/owner";
import { sandboxIdFor } from "../provider";
import { type Runtime, send, startRuntime, until } from "./harness";

const OWNER_A = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const OWNER_B = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
const SIBLING_KEY = "0123456789abcdef0123456789abcdef";

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

/** Every file under a directory, as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("regular runtime", () => {
  test("a bot runs in its own sandbox, sleeps when idle and wakes with its files", async () => {
    runtime = startRuntime(400);
    const bot = runtime.bots.forOwner(OWNER_A);
    const id = sandboxIdFor(bot.layout.botId);

    expect(await send(bot, "hello")).toMatchObject({ text: "pong 1: hello", end: expect.stringMatching(/^done b-/) });
    expect(runtime.provider.local.isAwake(id)).toBe(true);
    expect(readFileSync(bot.layout.stateSnapshot, "utf8")).toBe(id);

    await until(() => !runtime!.provider.local.isAwake(id));
    expect(existsSync(runtime.provider.local.snapshotOf(id))).toBe(true);
    expect(existsSync(runtime.provider.local.filesOf(id))).toBe(false);

    // The reply counts the turns the agent finds in its session: the second one only exists if the files came back.
    expect((await send(bot, "again")).text).toBe("pong 2: again");
    expect(runtime.provider.local.events.filter(event => event.id === id).map(event => event.operation))
      .toEqual(expect.arrayContaining(["create", "sleep", "wake"]));
    expect((await bot.list()).map(message => message.text)).toEqual(["hello", "pong 1: hello", "again", "pong 2: again"]);
  }, 60_000);

  test("sandboxes, bridges, gateway tokens and snapshots belong to one bot, across owners and within one owner", async () => {
    runtime = startRuntime(60_000);
    const mainA = runtime.bots.forOwner(OWNER_A);
    const siblingA = runtime.bots.forBot(OWNER_A, SIBLING_KEY);
    const mainB = runtime.bots.forOwner(OWNER_B);
    const bots = [mainA, siblingA, mainB];
    const ids = bots.map(bot => sandboxIdFor(bot.layout.botId));
    expect(new Set(ids).size).toBe(3);
    expect(mainA.layout.botId).toBe(botIdFor(OWNER_A));

    for (const [index, bot] of bots.entries()) expect((await send(bot, `secret ${index}`)).text).toBe(`pong 1: secret ${index}`);

    // What the service handed each sandbox: fresh tokens, and a gateway path naming that bot alone.
    const armed = ids.map(id => runtime!.provider.armed.get(id)!.at(-1)!);
    for (const [index, env] of armed.entries()) {
      expect(env.BOT_GATEWAY_URL).toBe(`${runtime.gatewayOrigin}/bots/${bots[index]!.layout.botId}/v1`);
      expect(env.BOT_BRIDGE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(env.BOT_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(armed.flatMap(env => [env.BOT_BRIDGE_TOKEN, env.BOT_TOKEN])).size).toBe(6);

    // Each bot reaches the gateway on its own path only, the sibling of the same owner included.
    expect((await send(mainA, "probe self")).text).toBe("gateway answered 200 for my own path");
    expect((await send(mainA, `probe ${siblingA.layout.botId}`)).text).toBe("gateway answered 403 for another bot's path");
    expect((await send(siblingA, `probe ${mainA.layout.botId}`)).text).toBe("gateway answered 403 for another bot's path");
    expect((await send(mainA, `probe ${mainB.layout.botId}`)).text).toBe("gateway answered 403 for another bot's path");
    expect((await send(mainB, `probe ${mainA.layout.botId}`)).text).toBe("gateway answered 403 for another bot's path");

    // One bot's tokens open nothing of another's, and a bot's own bridge takes one connection: the service's.
    for (const [index, id] of ids.entries()) {
      const endpoint = await runtime.provider.local.endpoint(id, 7070);
      const rpc = (token?: string) =>
        fetch(`${endpoint}/rpc`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(response => response.status);
      expect(await rpc()).toBe(401);
      for (const [other, env] of armed.entries()) if (other !== index) expect(await rpc(env.BOT_BRIDGE_TOKEN)).toBe(401);
      expect(await rpc(armed[index]!.BOT_BRIDGE_TOKEN)).toBe(409);
      for (const [other, env] of armed.entries()) {
        const status = (await fetch(`${runtime.gatewayOrigin}/bots/${bots[index]!.layout.botId}/v1/models`, {
          headers: { authorization: `Bearer ${env.BOT_TOKEN}` },
        })).status;
        expect(status).toBe(other === index ? 200 : 403);
      }
    }

    // Keep the sandboxes awake for the token checks, then stop them to inspect their snapshots.
    for (const bot of bots) expect(await bot.stop()).toBe(true);
    // Each snapshot holds its own bot's session alone, and no token.
    for (const id of ids) expect(runtime.provider.local.isAwake(id)).toBe(false);
    for (const [index, id] of ids.entries()) {
      const saved = allText(runtime.provider.local.snapshotOf(id));
      expect(saved).toContain(`secret ${index}`);
      for (const other of [0, 1, 2].filter(other => other !== index)) expect(saved).not.toContain(`secret ${other}`);
      for (const env of armed) {
        expect(saved).not.toContain(env.BOT_BRIDGE_TOKEN);
        expect(saved).not.toContain(env.BOT_TOKEN);
      }
    }

    // A woken bot gets new tokens; the old ones open neither its bridge nor its gateway path.
    const before = armed[0]!;
    expect((await send(mainA, "back")).text).toBe("pong 5: back");
    const after = runtime.provider.armed.get(ids[0]!)!.at(-1)!;
    expect(after.BOT_BRIDGE_TOKEN).not.toBe(before.BOT_BRIDGE_TOKEN);
    expect(after.BOT_TOKEN).not.toBe(before.BOT_TOKEN);
    const endpoint = await runtime.provider.local.endpoint(ids[0]!, 7070);
    expect((await fetch(`${endpoint}/rpc`, { headers: { authorization: `Bearer ${before.BOT_BRIDGE_TOKEN}` } })).status).toBe(401);
    expect((await fetch(`${runtime.gatewayOrigin}/bots/${mainA.layout.botId}/v1/models`, {
      headers: { authorization: `Bearer ${before.BOT_TOKEN}` },
    })).status).toBe(403);
  }, 120_000);

  test("deleting a bot's working state deletes its sandbox and its snapshots, and keeps everything when that fails", async () => {
    runtime = startRuntime(400);
    const bot = runtime.bots.forBot(OWNER_A, SIBLING_KEY);
    const id = sandboxIdFor(bot.layout.botId);
    await send(bot, "keep me");
    await until(() => !runtime!.provider.local.isAwake(id));

    runtime.provider.failDestroy = true;
    expect(await runtime.bots.deleteWorkingState(bot.layout.botId, "test")).toBe("error");
    expect(existsSync(bot.layout.stateSnapshot)).toBe(true);
    expect(existsSync(runtime.provider.local.snapshotOf(id))).toBe(true);

    runtime.provider.failDestroy = false;
    expect(await runtime.bots.deleteWorkingState(bot.layout.botId, "test")).toBeUndefined();
    expect(existsSync(bot.layout.dataDir)).toBe(false);
    expect(existsSync(runtime.provider.local.snapshotOf(id))).toBe(false);
    expect(runtime.provider.local.events.at(-1)).toEqual({ operation: "destroy", id });

    // Another bot of the same owner keeps its own.
    const other = runtime.bots.forOwner(OWNER_A);
    await send(other, "mine");
    expect(statSync(other.layout.dataDir).isDirectory()).toBe(true);
    expect((await send(bot, "fresh")).text).toBe("pong 1: fresh");
  }, 60_000);

  test("a sandbox the host will not put to sleep is left to the host's sweeper, and the bot still stops", async () => {
    runtime = startRuntime(60_000);
    const bot = runtime.bots.forOwner(OWNER_B);
    const id = sandboxIdFor(bot.layout.botId);
    await send(bot, "hi");
    runtime.provider.failSleep = true;
    expect(await bot.stop()).toBe(true);
    expect(runtime.provider.local.isAwake(id)).toBe(true);
    // Its gateway token went with the stop.
    const env = runtime.provider.armed.get(id)!.at(-1)!;
    expect((await fetch(`${runtime.gatewayOrigin}/bots/${bot.layout.botId}/v1/models`, {
      headers: { authorization: `Bearer ${env.BOT_TOKEN}` },
    })).status).toBe(403);
    // The sweeper's pass, once nothing touches it.
    runtime.provider.failSleep = false;
    await runtime.provider.local.sleepUnused(0);
    expect(runtime.provider.local.isAwake(id)).toBe(false);
    expect((await send(bot, "again")).text).toBe("pong 2: again");
  }, 60_000);
});
