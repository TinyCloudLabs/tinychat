import { describe, expect, test } from "bun:test";
import { BotDeletions, carryOutDeletion, type DeletionPorts } from "../bot-deletion.js";
import { BotsRegistry } from "../bots-registry.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROW = `bots/registry/${ADDRESS}`;
const KEY = "a".repeat(32);
const OTHER = "b".repeat(32);
const T0 = "2026-11-19T00:00:00.000Z";
const main = { key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0 };
const leaving = (extra: Record<string, unknown> = {}) => ({ ...main, key: KEY, name: "Research", state: "deleting", deletingSince: T0, ...extra });

/**
 * The real record over a fake store, and stand-ins for everything else that write down what they were asked and what
 * the record and the stored permission looked like at that moment. Nothing here reaches a node or a service.
 */
function world(bots: unknown[], options: { stored?: string; deleted?: unknown[] } = {}) {
  const kv = fakeRegistryStore();
  kv.rows.set(ROW, { version: 1, value: JSON.stringify({ v: 1, seq: 7, deleted: options.deleted ?? [], bots }) });
  const registry = new BotsRegistry(kv);
  const log: string[] = [];
  const state = { stored: options.stored as string | undefined, service: "gone" as "gone" | "waiting" | "failed", failCid: false, failForget: 0, failRevoke: 0 };
  /** The bot as the record holds it right now, in `bots` or in `deleted`. */
  const held = async () => {
    const row = await registry.read(ADDRESS);
    const bot = row.bots.find(entry => entry.key === KEY);
    if (bot) return `${bot.state}${bot.grantClosed ? "+closed" : ""}${bot.revoke ? `+revoke:${bot.revoke.cid}` : ""}`;
    const gone = row.deleted.find(entry => entry.key === KEY);
    return gone ? `deleted${gone.revoke ? `+revoke:${gone.revoke.cid}` : ""}` : "absent";
  };
  const ports: DeletionPorts = {
    registry,
    removeFromService: async (address, key, seq) => { log.push(`service ${address} ${key} seq=${seq}`); return state.service; },
    storedGrantCid: async () => {
      log.push("read permission");
      if (state.failCid) throw new Error("storage down");
      return state.stored;
    },
    forgetGrant: async () => {
      log.push(`forget permission [record: ${await held()}]`);
      if (state.failForget > 0) { state.failForget -= 1; throw new Error("storage down"); }
      state.stored = undefined;
    },
    revoke: async cid => {
      log.push(`revoke ${cid} [stored: ${state.stored ?? "none"}; record: ${await held()}]`);
      if (state.failRevoke > 0) { state.failRevoke -= 1; throw new Error("node refused"); }
    },
  };
  return { registry, ports, log, state, held };
}

describe("carrying out a deletion", () => {
  test("the service first, then the permission is closed with its delegation id, then removed, then revoked, then the bot leaves the list", async () => {
    const run = world([main, leaving()], { stored: "cid-1" });
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect(run.log).toEqual([
      `service ${ADDRESS} ${KEY} seq=7`,
      "read permission",
      // The close, with the id, was already in the record when the stored permission was removed.
      "forget permission [record: deleting+closed+revoke:cid-1]",
      // The stored permission was already gone when the delegation was revoked, and the id was still held.
      "revoke cid-1 [stored: none; record: deleting+closed+revoke:cid-1]",
    ]);
    const row = await run.registry.read(ADDRESS);
    expect([row.bots.map(bot => bot.key), row.deleted]).toEqual([["main"], [{ key: KEY, name: "Research" }]]);
  });

  test("while the service still has the bot's working state, nothing else happens", async () => {
    for (const answer of ["waiting", "failed"] as const) {
      const run = world([main, leaving()], { stored: "cid-1" });
      run.state.service = answer;
      expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe(answer);
      expect([run.log, await run.held(), run.state.stored]).toEqual([[`service ${ADDRESS} ${KEY} seq=7`], "deleting", "cid-1"]);
    }
  });

  test("if the stored permission cannot be read, nothing is closed and nothing is removed", async () => {
    const run = world([main, leaving()], { stored: "cid-1" });
    run.state.failCid = true;
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("failed");
    expect([run.log, await run.held(), run.state.stored]).toEqual([[`service ${ADDRESS} ${KEY} seq=7`, "read permission"], "deleting", "cid-1"]);
  });

  test("a bot with no stored permission is closed and deleted with nothing to revoke", async () => {
    const run = world([main, leaving()]);
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect(run.log).toEqual([`service ${ADDRESS} ${KEY} seq=7`, "read permission", "forget permission [record: deleting+closed]"]);
    expect(await run.held()).toBe("deleted");
  });

  test("if the stored permission cannot be removed the bot stays closed, and a later run finishes without asking the service again", async () => {
    const run = world([main, leaving()], { stored: "cid-1" });
    run.state.failForget = 1;
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("failed");
    expect([await run.held(), run.state.stored]).toEqual(["deleting+closed+revoke:cid-1", "cid-1"]);
    run.log.length = 0;
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect(run.log).toEqual([
      "forget permission [record: deleting+closed+revoke:cid-1]",
      "revoke cid-1 [stored: none; record: deleting+closed+revoke:cid-1]",
    ]);
    expect(await run.held()).toBe("deleted");
  });

  test("after a restart the delegation id comes from the record, even though the stored permission is already gone", async () => {
    const run = world([main, leaving({ grantClosed: true, revoke: { cid: "cid-1" } })]);
    run.state.failCid = true; // reading the store would throw: it must not be needed
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect(run.log).toEqual([
      "forget permission [record: deleting+closed+revoke:cid-1]",
      "revoke cid-1 [stored: none; record: deleting+closed+revoke:cid-1]",
    ]);
    expect((await run.registry.read(ADDRESS)).deleted).toEqual([{ key: KEY, name: "Research" }]);
  });

  test("a revocation that fails does not hold the deletion up, and its id is kept and tried again on a later run", async () => {
    const run = world([main, leaving()], { stored: "cid-1" });
    run.state.failRevoke = 1;
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect(await run.held()).toBe("deleted+revoke:cid-1");
    run.log.length = 0;
    // A later run on the deleted bot: its stored permission is removed again in case one came back, and the id retried.
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect(run.log).toEqual(["forget permission [record: deleted+revoke:cid-1]", "revoke cid-1 [stored: none; record: deleted+revoke:cid-1]"]);
    expect(await run.held()).toBe("deleted");
  });

  test("a permission that came back for a deleted bot is removed", async () => {
    const run = world([main], { stored: "cid-9", deleted: [{ key: KEY, name: "Research" }] });
    expect(await carryOutDeletion(run.ports, ADDRESS, KEY)).toBe("deleted");
    expect([run.log, run.state.stored]).toEqual([["forget permission [record: deleted]"], undefined]);
  });

  test("a bot that is not being deleted is left alone", async () => {
    const run = world([main, { ...main, key: OTHER, name: "Notes" }], { stored: "cid-1" });
    for (const key of [OTHER, "main", "9".repeat(32), "../x"]) {
      expect([key, await carryOutDeletion(run.ports, ADDRESS, key)]).toEqual([key, "not_deleting"]);
    }
    expect([run.log, run.state.stored]).toEqual([[], "cid-1"]);
  });
});

describe("running deletions", () => {
  const A = `0x${"1".repeat(40)}`;
  const B = `0x${"2".repeat(40)}`;
  const C = `0x${"3".repeat(40)}`;
  const K1 = "1".repeat(32);
  const K2 = "2".repeat(32);
  const K3 = "3".repeat(32);
  const bot = (key: string, state: string, extra: Record<string, unknown> = {}) => ({ ...main, key, name: `Bot ${key[0]}`, state, ...(state === "deleting" ? { deletingSince: T0 } : {}), ...extra });

  /** Several owners in one store, and stand-ins that write down which bot they were asked about. The service always says "waiting". */
  function owners(records: Record<string, { bots: unknown[]; deleted?: unknown[] } | string>) {
    const kv = fakeRegistryStore();
    for (const [address, record] of Object.entries(records)) {
      kv.rows.set(`bots/registry/${address}`, { version: 1, value: typeof record === "string" ? record : JSON.stringify({ v: 1, seq: 3, deleted: record.deleted ?? [], bots: record.bots }) });
    }
    const asked: string[] = [];
    /** `hold` makes the service stand-in wait, `entered` resolves once it has been reached, `release` lets it answer. */
    let signalEntered!: () => void;
    const gate = { release: undefined as undefined | (() => void), hold: false, entered: new Promise<void>(resolve => { signalEntered = resolve; }) };
    const deletions = new BotDeletions({
      registry: new BotsRegistry(kv),
      removeFromService: async (address, key) => {
        asked.push(`service ${address} ${key}`);
        signalEntered();
        if (gate.hold) await new Promise<void>(resolve => { gate.release = resolve; });
        return "waiting";
      },
      storedGrantCid: async () => undefined,
      forgetGrant: async (address, key) => { asked.push(`forget ${address} ${key}`); },
      revoke: async cid => { asked.push(`revoke ${cid}`); },
    });
    return { kv, asked, gate, deletions };
  }

  test("a second run for the same bot is not started while the first is under way", async () => {
    const run = owners({ [A]: { bots: [main, bot(K1, "deleting")] } });
    run.gate.hold = true;
    const first = run.deletions.run(A, K1);
    await run.gate.entered;
    // The same bot, however the address is written, is the same run.
    expect(await run.deletions.run(A.toUpperCase().replace("0X", "0x"), K1)).toBe("busy");
    run.gate.release?.();
    expect(await first).toBe("waiting");
    expect(run.asked).toEqual([`service ${A} ${K1}`]);
    // Once it has ended, a new run may start.
    run.gate.hold = false;
    expect(await run.deletions.run(A, K1)).toBe("waiting");
  });

  test("a failure is an outcome, never an exception", async () => {
    const run = owners({ [A]: { bots: [main, bot(K1, "deleting")] } });
    run.kv.down = true;
    expect(await run.deletions.run(A, K1)).toBe("failed");
    expect(await run.deletions.run("not an address", K1)).toBe("failed");
  });

  test("a pass runs every outstanding deletion of every owner, and nothing else", async () => {
    const run = owners({
      [A]: { bots: [main, bot(K1, "deleting"), bot(K2, "active")] },
      [B]: { bots: [main, bot(K3, "suspended")], deleted: [{ key: K1, name: "Gone" }, { key: K2, name: "Owed", revoke: { cid: "cid-7" } }] },
      [C]: { bots: [main] },
    });
    expect(await run.deletions.sweep()).toEqual({ listed: true, ran: 1, skipped: 0 });
    // A revocation still owed for a deleted bot is not tried again here. A node refuses one from the backend, which
    // only holds the grant (403, seen against a real node): the id stays in the record for the owner, who can.
    expect(run.asked).toEqual([`service ${A} ${K1}`]);
  });

  test("an owner whose record cannot be read is skipped, and the others are still done", async () => {
    const run = owners({ [A]: "not a record", [B]: { bots: [main, bot(K1, "deleting")] } });
    expect(await run.deletions.sweep()).toEqual({ listed: true, ran: 1, skipped: 1 });
    expect(run.asked).toEqual([`service ${B} ${K1}`]);
  });

  test("when the owners cannot be listed, the pass does nothing and says so", async () => {
    const run = owners({ [A]: { bots: [main, bot(K1, "deleting")] } });
    run.kv.cutShort = true;
    expect(await run.deletions.sweep()).toEqual({ listed: false, ran: 0, skipped: 0 });
    expect(run.asked).toEqual([]);
  });
});
