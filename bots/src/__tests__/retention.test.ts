import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, BotManager, type ErrorCode, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import { type BotLayout, botLayout, type LayoutRoots } from "../layout";
import { botIdFor } from "../owner";
import type { Frame } from "../rpc";
import { rootProblem, removeWorkingState } from "../retention";
import { chmodSync } from "node:fs";
import { parseMountinfo, runStateCopy, StateCopiers } from "../sandbox";

const tmp = mkdtempSync(join(tmpdir(), "bots-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Empty data, run and egress roots of their own under the test's temp directory. */
function roots(): LayoutRoots {
  const dir = mkdtempSync(join(tmp, "roots-"));
  return { dataRoot: join(dir, "data"), runRoot: join(dir, "run"), egressRoot: join(dir, "egress") };
}

/** Stands in for OMP behind the RPC channel: records commands and lets the test emit frames. */
class FakeSandbox implements Sandbox {
  readonly commands: Record<string, unknown>[] = [];
  readonly #listeners = new Set<(frame: Frame) => void>();
  readonly #exit = Promise.withResolvers<void>();
  readonly exited = this.#exit.promise;
  readonly prompted = Promise.withResolvers<string>();
  #seq = 0;

  nextId(): string {
    return `p-${++this.#seq}`;
  }
  async request(command: Record<string, unknown>): Promise<unknown> {
    this.commands.push(command);
    if (command.type === "prompt") this.prompted.resolve(command.id as string);
    return { agentInvoked: true };
  }
  onFrame(listener: (frame: Frame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(frame: Frame): void {
    for (const listener of this.#listeners) listener(frame);
  }
  async snapshot(): Promise<void> {}
  async refreshEgress(): Promise<void> {}
  async stop(): Promise<void> {
    this.#exit.resolve();
  }
}

function recorder() {
  const events: Array<[string, unknown]> = [];
  const sink: TurnSink = {
    status: state => events.push(["status", state]),
    delta: text => events.push(["delta", text]),
    done: messageId => events.push(["done", messageId]),
    error: (code: ErrorCode) => events.push(["error", code]),
  };
  return { events, sink };
}
const OPTIONS = { idleMs: 60_000, turnTimeoutMs: 300_000, maxTurnBytes: 16 };
describe("working state retention", () => {
  const DAY = 24 * 60 * 60_000;
  const RETENTION = 30 * DAY;
  const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
  const OTHER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";

  /** A manager over temp roots whose launches act on disk like RunscHost: the first creates the state image. */
  function host(maxRunning = 8) {
    const dirs = roots();
    const fake = { launches: 0, next: new FakeSandbox(), hold: Promise.resolve(), mounts: [] as string[], leftover: false, copiers: new StateCopiers() };
    const launcher: SandboxLauncher = {
      leftover: (layout, sandboxOnly) => fake.leftover || (!sandboxOnly && fake.copiers.has(layout.botId)),
      hasState: layout => existsSync(layout.stateSnapshot),
      launch: async layout => {
        await fake.hold;
        fake.launches++;
        mkdirSync(layout.stateMount, { recursive: true });
        mkdirSync(layout.dataDir, { recursive: true });
        if (!existsSync(layout.stateSnapshot)) writeFileSync(layout.stateSnapshot, "fresh");
        const sandbox = fake.next;
        fake.next = new FakeSandbox();
        return sandbox;
      },
      mountPoints: () => fake.mounts,
    };
    const manager = new BotManager(launcher, dirs, OPTIONS, maxRunning);
    return { fake, dirs, manager, layout: (owner: string) => botLayout(botIdFor(owner), dirs) };
  }

  /** The state_deleted and state_delete_skipped events `run` logs. */
  async function stateEvents(run: () => Promise<unknown>): Promise<unknown[]> {
    const spy = spyOn(console, "log");
    try {
      await run();
      return spy.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { bots: string })
        .filter(event => event.bots === "state_deleted" || event.bots === "state_delete_skipped");
    } finally {
      spy.mockRestore();
    }
  }
  const skipped = (cause: string) => ({ bots: "state_delete_skipped", bot: botIdFor(OWNER).slice(0, 12), reason: "unused", cause });

  /** A stopped bot that has run before: old notes in its state image, and a marker unless `usedAt` is null. */
  function existing(layout: BotLayout, usedAt: number | null, imageAt = usedAt ?? Date.now()) {
    mkdirSync(layout.dataDir, { recursive: true });
    writeFileSync(layout.stateSnapshot, "old notes");
    utimesSync(layout.stateSnapshot, imageAt / 1000, imageAt / 1000);
    if (usedAt !== null) writeFileSync(layout.lastUsedFile, new Date(usedAt).toISOString());
  }

  /** Sends one message and completes its turn. */
  async function converse(bot: Bot, sandbox: FakeSandbox) {
    const { events, sink } = recorder();
    const running = bot.send("hi", sink);
    const id = await sandbox.prompted.promise;
    sandbox.emit({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
    await running;
    return events;
  }

  test("a sweep deletes a bot unused for longer than the retention and keeps a recently used one", async () => {
    const { fake, manager, layout } = host();
    const sandbox = fake.next;
    await converse(manager.forOwner(OWNER), sandbox);
    expect(existsSync(layout(OWNER).lastUsedFile)).toBe(true);
    const later = Date.now() + RETENTION + DAY;
    existing(layout(OTHER), later - DAY);
    await manager.sweepUnused(RETENTION, later);
    expect(Bun.peek.status(sandbox.exited)).toBe("fulfilled");
    expect(existsSync(layout(OWNER).dataDir)).toBe(false);
    expect(existsSync(layout(OWNER).bundleDir)).toBe(false);
    expect(readFileSync(layout(OTHER).stateSnapshot, "utf8")).toBe("old notes");
  });

  test("a bot with a turn in flight is not deleted", async () => {
    const { fake, manager, layout } = host();
    const sandbox = fake.next;
    const { events, sink } = recorder();
    const running = manager.forOwner(OWNER).send("hi", sink);
    const id = await sandbox.prompted.promise;
    await manager.sweepUnused(RETENTION, Date.now() + RETENTION + DAY);
    expect(existsSync(layout(OWNER).stateSnapshot)).toBe(true);
    sandbox.emit({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
    await running;
    expect(events.at(-1)?.[0]).toBe("done");
  });

  test("a bot whose sandbox is still starting for a request is not deleted", async () => {
    const { fake, manager, layout } = host();
    existing(layout(OWNER), Date.now() - RETENTION - DAY);
    const launched = Promise.withResolvers<void>();
    fake.hold = launched.promise;
    const replying = converse(manager.forOwner(OWNER), fake.next);
    await manager.sweepUnused(RETENTION);
    expect(readFileSync(layout(OWNER).stateSnapshot, "utf8")).toBe("old notes");
    launched.resolve();
    expect((await replying).at(-1)?.[0]).toBe("done");
  });

  test("a message that arrives during deletion waits for it, then starts a fresh bot", async () => {
    const { fake, manager, layout } = host();
    const bot = manager.forOwner(OWNER);
    await converse(bot, fake.next);
    writeFileSync(layout(OWNER).stateSnapshot, "old notes");
    const sweeping = manager.sweepUnused(RETENTION, Date.now() + RETENTION + DAY);
    const replying = converse(bot, fake.next);
    await sweeping;
    expect(await replying).toEqual([
      ["status", "starting"],
      ["status", "working"],
      ["done", expect.stringMatching(/^b-\d+$/)],
    ]);
    // Launched only once the old state was gone: a launch before the removal would have kept the old notes or
    // had its own state image removed.
    expect(fake.launches).toBe(2);
    expect(readFileSync(layout(OWNER).stateSnapshot, "utf8")).toBe("fresh");
    expect(existsSync(layout(OWNER).lastUsedFile)).toBe(true);
  });

  test("a bot without a marker counts from its state image's mtime", async () => {
    const { manager, layout } = host();
    const now = Date.now();
    existing(layout(OWNER), null, now - RETENTION - DAY);
    existing(layout(OTHER), null, now - DAY);
    await manager.sweepUnused(RETENTION, now);
    expect(existsSync(layout(OWNER).dataDir)).toBe(false);
    expect(readFileSync(layout(OTHER).stateSnapshot, "utf8")).toBe("old notes");
  });

  test("entries in the data root that are not bot ids are left alone", async () => {
    const { dirs, manager } = host();
    const old = (Date.now() - RETENTION - DAY) / 1000;
    const names = ["lost+found", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}.old`];
    for (const name of names) {
      mkdirSync(join(dirs.dataRoot, name), { recursive: true });
      writeFileSync(join(dirs.dataRoot, name, "state.img"), "x");
      utimesSync(join(dirs.dataRoot, name, "state.img"), old, old);
    }
    await manager.sweepUnused(RETENTION);
    for (const name of names) expect(existsSync(join(dirs.dataRoot, name, "state.img"))).toBe(true);
  });

  test("a failed teardown keeps both directories and logs the deletion as skipped; the next sweep retries", async () => {
    const { fake, manager, layout } = host();
    const sandbox = fake.next;
    await converse(manager.forOwner(OWNER), sandbox);
    sandbox.stop = async () => {
      throw new Error("umount failed");
    };
    const later = Date.now() + RETENTION + DAY;
    expect(await stateEvents(() => manager.sweepUnused(RETENTION, later))).toEqual([skipped("teardown_failed")]);
    expect(readFileSync(layout(OWNER).stateSnapshot, "utf8")).toBe("fresh");
    expect(existsSync(layout(OWNER).stateMount)).toBe(true);
    await manager.sweepUnused(RETENTION, later);
    expect(existsSync(layout(OWNER).dataDir)).toBe(false);
  });

  test("a mount left under the bot's run directory blocks deletion", async () => {
    const { fake, manager, layout } = host();
    existing(layout(OWNER), Date.now() - RETENTION - DAY);
    mkdirSync(layout(OWNER).stateMount, { recursive: true });
    fake.mounts = ["/", "/proc", realpathSync(layout(OWNER).stateMount)];
    expect(await stateEvents(() => manager.sweepUnused(RETENTION))).toEqual([skipped("mounted")]);
    expect(readFileSync(layout(OWNER).stateSnapshot, "utf8")).toBe("old notes");
    expect(existsSync(layout(OWNER).stateMount)).toBe(true);
  });

  test("a symlink named by a bot id is never followed: the sweep ignores it and a deletion refuses it", async () => {
    const { dirs, manager, layout } = host();
    const target = mkdtempSync(join(tmp, "elsewhere-"));
    const old = (Date.now() - RETENTION - DAY) / 1000;
    writeFileSync(join(target, "state.img"), "not a bot");
    utimesSync(join(target, "state.img"), old, old);
    mkdirSync(dirs.dataRoot, { recursive: true });
    symlinkSync(target, layout(OWNER).dataDir);
    const events = await stateEvents(async () => {
      await manager.sweepUnused(RETENTION);
      await manager.deleteWorkingState(botIdFor(OWNER), "unused");
    });
    expect(events).toEqual([skipped("unsafe_path")]);
    expect(lstatSync(layout(OWNER).dataDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "state.img"), "utf8")).toBe("not a bot");
  });

  test("stopAll prevents deletion after closing begins", async () => {
    const { fake, manager, layout } = host();
    const sandbox = fake.next;
    await converse(manager.forOwner(OWNER), sandbox);
    const stopped = Promise.withResolvers<void>();
    sandbox.stop = () => stopped.promise;
    const sweeping = manager.sweepUnused(RETENTION, Date.now() + RETENTION + DAY);
    const deletedBeforeStopAllReturned = manager.stopAll().then(() => !existsSync(layout(OWNER).dataDir));
    stopped.resolve();
    expect(await deletedBeforeStopAllReturned).toBe(false);
    await sweeping;
  });

  test("an invalid present marker keeps old state and logs the refused sweep", async () => {
    const { manager, layout } = host();
    existing(layout(OWNER), null, Date.now() - RETENTION - DAY);
    writeFileSync(layout(OWNER).lastUsedFile, "invalid");
    const spy = spyOn(console, "log");
    try {
      await manager.sweepUnused(RETENTION);
      expect(readFileSync(layout(OWNER).stateSnapshot, "utf8")).toBe("old notes");
      expect(spy.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        bots: "sweep_failed", bot: botIdFor(OWNER).slice(0, 12), error: "invalid last-used marker",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("an unconfirmed launcher leftover keeps state even without a live sandbox handle", async () => {
    const { fake, manager, layout } = host();
    existing(layout(OWNER), Date.now() - RETENTION - DAY);
    mkdirSync(layout(OWNER).stateMount, { recursive: true });
    fake.leftover = true;
    expect(await stateEvents(() => manager.sweepUnused(RETENTION))).toEqual([skipped("teardown_failed")]);
    expect(readFileSync(layout(OWNER).stateSnapshot, "utf8")).toBe("old notes");
    expect(existsSync(layout(OWNER).stateMount)).toBe(true);
  });

  test("a mount under a sibling with the same path prefix does not block this bot", async () => {
    const { fake, manager, layout } = host();
    existing(layout(OWNER), Date.now() - RETENTION - DAY);
    fake.mounts = [layout(OWNER).dataDir + "-sibling/state"];
    await manager.sweepUnused(RETENTION);
    expect(existsSync(layout(OWNER).dataDir)).toBe(false);
  });

  test("an unreaped copier bounds teardown, blocks deletion and copies, and releases the sandbox slot", async () => {
    const { fake, manager, layout } = host(1);
    const sandbox = fake.next;
    await converse(manager.forOwner(OWNER), sandbox);
    const exit = Promise.withResolvers<number>();
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      exited: exit.promise,
      stdout: new ReadableStream({ start(controller) { controller.close(); } }),
      kill: () => {},
    }) as never);
    const stop = sandbox.stop.bind(sandbox);
    sandbox.stop = async () => {
      const failure = await fake.copiers.run(botIdFor(OWNER), ["copier"], 1, 10);
      await stop();
      if (failure === "copier_leftover") throw new Error("state copier exit unconfirmed");
    };
    try {
      const events = await stateEvents(() => manager.sweepUnused(RETENTION, Date.now() + RETENTION + DAY));
      expect(events).toEqual([skipped("teardown_failed")]);
      expect(fake.copiers.has(botIdFor(OWNER))).toBe(true);
      expect(existsSync(layout(OWNER).dataDir)).toBe(true);
      expect(existsSync(layout(OWNER).stateMount)).toBe(true);
      expect(await fake.copiers.run(botIdFor(OWNER), ["another copier"], 1, 10)).toBe("copier_leftover");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(await stateEvents(() => manager.deleteWorkingState(botIdFor(OWNER), "unused"))).toEqual([skipped("teardown_failed")]);
      expect((await converse(manager.forOwner(OTHER), fake.next)).at(-1)?.[0]).toBe("done");
      exit.resolve(137);
      await exit.promise;
      expect(fake.copiers.has(botIdFor(OWNER))).toBe(false);
      await manager.deleteWorkingState(botIdFor(OWNER), "unused");
      expect(existsSync(layout(OWNER).dataDir)).toBe(false);
    } finally {
      exit.resolve(137);
      spawn.mockRestore();
    }
  });

  test("mount points come from mountinfo field 5 with octal escapes decoded", () => {
    const mountinfo = [
      "36 35 98:0 / /data rw,noatime master:1 - ext4 /dev/vda1 rw",
      "52 36 7:0 / /run/bots/a\\040b/state rw,nosuid,nodev - ext4 /dev/loop0 rw",
      "",
    ].join("\n");
    expect(parseMountinfo(mountinfo)).toEqual(["/data", "/run/bots/a b/state"]);
  });
});

test("trusted roots reject symlinks, wrong owners and writable permissions", () => {
  const dir = mkdtempSync(join(tmp, "trusted-"));
  chmodSync(dir, 0o700);
  expect(rootProblem(dir, process.geteuid!())).toBeUndefined();
  expect(rootProblem(dir, process.geteuid!() + 1)).toBe("wrong_owner");
  chmodSync(dir, 0o777);
  expect(rootProblem(dir, process.geteuid!())).toBe("group_or_world_writable");
  const link = dir + "-link";
  symlinkSync(dir, link);
  expect(rootProblem(link, process.geteuid!())).toBe("symlink");
});
test("crafted traversal layout is refused", async () => {
  const dirs = roots();
  mkdirSync(dirs.dataRoot, {recursive:true});
  const layout = botLayout("c".repeat(64), dirs);
  layout.botId = "..";
  expect(await removeWorkingState(layout, {mountPoints: () => []})).toBe("unsafe_path");
});

test("a real directory belonging to a different bot is refused", async () => {
  const dirs = roots();
  const layout = botLayout("c".repeat(64), dirs);
  layout.dataDir = join(dirs.dataRoot, "d".repeat(64));
  mkdirSync(layout.dataDir, { recursive: true });
  writeFileSync(join(layout.dataDir, "notes"), "keep");
  expect(await removeWorkingState(layout, { mountPoints: () => [] })).toBe("unsafe_path");
  expect(readFileSync(join(layout.dataDir, "notes"), "utf8")).toBe("keep");
});

test("a timed-out copier holds teardown until its exit is confirmed", async () => {
  const exit = Promise.withResolvers<number>();
  const killed = Promise.withResolvers<void>();
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
    exited: exit.promise,
    stdout: new ReadableStream({ start(controller) { controller.close(); } }),
    kill: () => killed.resolve(),
  }) as never);
  let returned = false;
  const copying = runStateCopy(["copier"], 1).then(result => { returned = true; return result; });
  try {
    await killed.promise;
    await Bun.sleep(10);
    expect(returned).toBe(false);
    exit.resolve(137);
    expect(await copying).toBe("timeout");
  } finally {
    exit.resolve(137);
    await copying;
    spawn.mockRestore();
  }
});
