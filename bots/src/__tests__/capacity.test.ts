import { describe, expect, test } from "bun:test";
import { BotManager, type ErrorCode, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import type { Frame } from "../rpc";
import { createApp } from "../server";

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
  async complete(): Promise<void> {
    const id = await this.prompted.promise;
    for (const listener of this.#listeners) listener({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
  }
  async refreshEgress(): Promise<void> {}
  async snapshot(): Promise<void> {}
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

const OPTIONS = { idleMs: 60_000, turnTimeoutMs: 300_000, maxTurnBytes: 1024 };
const ROOTS = { dataRoot: "/d", runRoot: "/r", egressRoot: "/e" };
const OWNER_A = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const OWNER_B = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";

function setup(maxRunning: number, failLaunches = 0) {
  const sandboxes = Array.from({ length: 4 }, () => new FakeSandbox());
  const launched = { count: 0 };
  let failures = failLaunches;
  const launcher: SandboxLauncher = {
    hasState: () => true,
    leftover: () => false,
    launch: async () => {
      if (failures-- > 0) throw new Error("runsc failed");
      return sandboxes[launched.count++]!;
    },
  };
  return { sandboxes, launched, manager: new BotManager(launcher, ROOTS, OPTIONS, maxRunning) };
}

describe("a start past BOTS_MAX_RUNNING", () => {
  test("is refused with at_capacity; the first bot finishes, then the second starts normally and nothing leaks", async () => {
    const { manager, sandboxes, launched } = setup(1);
    const first = manager.forOwner(OWNER_A);
    const second = manager.forOwner(OWNER_B);

    const firstTurn = recorder();
    const firstRun = first.send("one", firstTurn.sink);
    await sandboxes[0]!.prompted.promise;

    // Refused, twice: the refusal leaves the bot free to send again (not "busy") and takes no place.
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = recorder();
      await second.send("two", refused.sink);
      expect(refused.events).toEqual([
        ["status", "starting"],
        ["error", "at_capacity"],
      ]);
    }
    expect(launched.count).toBe(1);
    expect(second.inUse).toBe(false);

    await sandboxes[0]!.complete();
    await firstRun;
    expect(firstTurn.events.at(-1)?.[0]).toBe("done");
    await first.stop();

    const later = recorder();
    const laterRun = second.send("two", later.sink);
    await sandboxes[1]!.prompted.promise;
    await sandboxes[1]!.complete();
    await laterRun;
    expect(later.events.map(([name]) => name)).toEqual(["status", "status", "done"]);
    expect(launched.count).toBe(2);

    // The first bot's place went to the second: a refusal now would show a leak or a double take.
    await second.stop();
    const again = first.send("one more", recorder().sink);
    await sandboxes[2]!.prompted.promise;
    await sandboxes[2]!.complete();
    await again;
  });

  test("a launch that fails is still bot_unavailable and gives its place back", async () => {
    const { manager, sandboxes } = setup(1, 1);
    const bot = manager.forOwner(OWNER_A);
    const failed = recorder();
    await bot.send("hi", failed.sink);
    expect(failed.events.at(-1)).toEqual(["error", "bot_unavailable"]);

    const retry = recorder();
    const run = bot.send("hi", retry.sink);
    await sandboxes[0]!.prompted.promise;
    await sandboxes[0]!.complete();
    await run;
    expect(retry.events.at(-1)?.[0]).toBe("done");
  });

  test("reaches the caller as an error event with the code and the sentence", async () => {
    const { manager, sandboxes } = setup(1);
    const app = createApp({
      secret: "s".repeat(64),
      accounts: new Set(["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"]),
      bots: { forOwner: owner => manager.forOwner(owner) },
    });
    const post = (owner: string) =>
      app(new Request("http://bots.internal/v1/bots/main/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(64)}`, "x-tinycloud-owner": owner },
        body: '{"text":"hi"}',
      }));
    const firstResponse = post(OWNER_A);
    await sandboxes[0]!.prompted.promise;

    const body = await (await post(OWNER_B)).text();
    expect(body).toContain("event: error");
    expect(JSON.parse(body.split("event: error\ndata: ")[1]!.split("\n")[0]!)).toEqual({
      code: "at_capacity",
      message: "Main can't start right now because TinyCloud is running as many bots as it can. Your message wasn't sent. Try again shortly.",
    });

    await sandboxes[0]!.complete();
    expect(await (await firstResponse).text()).toContain("event: done");
  });
});
