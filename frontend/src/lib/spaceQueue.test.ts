import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { runOnSpace, scheduledSpace } from "./spaceQueue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A task that records when it runs, and finishes only when released. */
function gated(log: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = async () => {
    log.push(`start ${name}`);
    await gate;
    log.push(`end ${name}`);
    return name;
  };
  return { task, release };
}

describe("runOnSpace", () => {
  test("two tasks on one space never overlap, and run first in first out", async () => {
    const log: string[] = [];
    const a = gated(log, "a");
    const b = gated(log, "b");
    const c = gated(log, "c");
    const done = [runOnSpace("space-1", a.task), runOnSpace("space-1", b.task), runOnSpace("space-1", c.task)];
    await tick();
    expect(log).toEqual(["start a"]);
    b.release(); // b may not start before a ends, released or not
    await tick();
    expect(log).toEqual(["start a"]);
    a.release();
    await tick();
    await tick();
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c"]);
    c.release();
    expect(await Promise.all(done)).toEqual(["a", "b", "c"]);
  });

  test("a rejection reaches its caller and never blocks the queue", async () => {
    const failing = runOnSpace("space-2", async () => {
      throw new Error("dropped");
    });
    const next = runOnSpace("space-2", async () => "after");
    await expect(failing).rejects.toThrow("dropped");
    expect(await next).toBe("after");
  });

  test("different spaces do not wait for each other", async () => {
    const log: string[] = [];
    const held = gated(log, "held");
    void runOnSpace("space-3", held.task);
    expect(await runOnSpace("space-4", async () => "free")).toBe("free");
    held.release();
  });
});

describe("scheduledSpace", () => {
  function fakeTcw(log: string[]) {
    const call = (name: string) => async (...args: unknown[]) => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      return { ok: true, data: { name, args } };
    };
    const db = { name: "db", query: call("db.query"), execute: call("db.execute"), migrations: { kind: "migrations" } };
    return {
      did: "did:example:1",
      spaceId: "space-sched",
      secrets: { isUnlocked: false },
      address() {
        return this.did;
      },
      kv: { get: call("kv.get"), put: call("kv.put"), withPrefix: (prefix: string) => ({ prefix }), config: { prefix: "app" } },
      sql: { db: (name: string) => ({ ...db, name }), query: call("sql.query") },
    } as unknown as TinyCloudWeb;
  }

  test("kv calls and sql.db(name) calls take turns: one task each, never overlapping", async () => {
    const log: string[] = [];
    const space = scheduledSpace(fakeTcw(log));
    const results = await Promise.all([
      space.kv.get("a"),
      space.sql.db("connectors").query("SELECT 1"),
      space.kv.put("b", 1),
      space.sql.db("connectors").execute("UPDATE"),
    ]);
    expect(log).toEqual([
      "start kv.get",
      "end kv.get",
      "start db.query",
      "end db.query",
      "start kv.put",
      "end kv.put",
      "start db.execute",
      "end db.execute",
    ]);
    // Arguments and results pass through untouched.
    expect(results[0]).toEqual({ ok: true, data: { name: "kv.get", args: ["a"] } });
    expect(results[1]).toEqual({ ok: true, data: { name: "db.query", args: ["SELECT 1"] } });
  });

  test("everything else passes through: identity, secrets, synchronous members, data", () => {
    const tcw = fakeTcw([]);
    const space = scheduledSpace(tcw);
    expect(space.did).toBe("did:example:1");
    expect(space.spaceId).toBe("space-sched");
    expect((space as unknown as { secrets: unknown }).secrets).toBe((tcw as unknown as { secrets: unknown }).secrets);
    expect(space.address()).toBe("did:example:1");
    // Synchronous members stay synchronous.
    expect(space.kv.withPrefix("x")).toEqual({ prefix: "x" } as never);
    expect((space.kv as unknown as { config: unknown }).config).toEqual({ prefix: "app" });
    expect(space.sql.db("connectors").name).toBe("connectors");
    expect((space.sql.db("connectors") as unknown as { migrations: unknown }).migrations).toEqual({ kind: "migrations" });
  });

  test("one scheduled handle per session, so React dependencies stay stable", () => {
    const tcw = fakeTcw([]);
    expect(scheduledSpace(tcw)).toBe(scheduledSpace(tcw));
    expect(scheduledSpace(tcw).kv).toBe(scheduledSpace(tcw).kv);
    expect(scheduledSpace(fakeTcw([]))).not.toBe(scheduledSpace(tcw));
  });

  test("a session's queue is shared with direct runOnSpace work on the same space", async () => {
    const log: string[] = [];
    const space = scheduledSpace(fakeTcw(log));
    const held = gated(log, "upload part");
    const upload = runOnSpace("space-sched", held.task);
    const read = space.kv.get("library");
    await tick();
    expect(log).toEqual(["start upload part"]);
    held.release();
    await Promise.all([upload, read]);
    expect(log).toEqual(["start upload part", "end upload part", "start kv.get", "end kv.get"]);
  });
});
