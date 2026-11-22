import { expect, test } from "bun:test";
import { Bot, RunningLimit, type Sandbox, type SandboxLauncher, type TurnOrigin, type TurnSink } from "../bot";
import { botLayout } from "../layout";
import type { Frame } from "../rpc";

/** Stands in for OMP: completes every prompt at once and keeps the message it was sent. */
class PromptRecorder implements Sandbox {
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(frame: Frame) => void>();
  readonly #exit = Promise.withResolvers<void>();
  readonly exited = this.#exit.promise;
  #seq = 0;

  nextId(): string {
    return `p-${++this.#seq}`;
  }
  async request(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "prompt") {
      this.prompts.push(String(command.message));
      queueMicrotask(() => {
        for (const listener of this.#listeners) {
          listener({ type: "prompt_result", id: command.id, status: "completed", agentInvoked: true, sessionSettled: true });
        }
      });
    }
    return { agentInvoked: true };
  }
  onFrame(listener: (frame: Frame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async refreshEgress(): Promise<void> {}
  async snapshot(): Promise<void> {}
  async stop(): Promise<void> {
    this.#exit.resolve();
  }
}

async function promptFor(text: string, from: TurnOrigin): Promise<string> {
  const sandbox = new PromptRecorder();
  const launcher: SandboxLauncher = { hasState: () => true, leftover: () => false, launch: async () => sandbox };
  const layout = botLayout("c".repeat(64), { dataRoot: "/d", runRoot: "/r", egressRoot: "/e" });
  const bot = new Bot(layout, launcher, { idleMs: 60_000, turnTimeoutMs: 10_000, maxTurnBytes: 4_096 }, new RunningLimit(1));
  const ends: string[] = [];
  const sink: TurnSink = { status: () => {}, delta: () => {}, done: () => ends.push("done"), error: code => ends.push(code) };
  await bot.send(text, sink, undefined, undefined, from);
  await bot.stop();
  expect(ends).toEqual(["done"]);
  expect(sandbox.prompts).toHaveLength(1);
  return sandbox.prompts[0]!;
}

test("the owner's own turn reaches OMP as written, slash commands included", async () => {
  expect(await promptFor("/compact", "owner")).toBe("/compact");
});

test("another bot's turn reaches OMP under a first line naming its origin, so it never starts with a slash", async () => {
  const prompt = await promptFor("/compact", "bot");
  expect(prompt.split("\n")).toEqual(["[TinyCloud: this message is from another of the owner's bots, not from the owner.]", "/compact"]);
  expect(prompt.startsWith("/")).toBe(false);
});

test("another bot's @ file mentions arrive as text OMP does not load, and an email address arrives unchanged", async () => {
  const text = "see @/root/bot/sessions/main (@'notes.md') and write to ana@example.com";
  const body = (await promptFor(text, "bot")).split("\n").slice(1).join("\n");
  // OMP loads `@<path>` at the start or after a space or opening mark (file-mentions.ts in OMP 18.18.6).
  expect(body).not.toMatch(/(^|[\s([{<"'`])@[^\u2060]/);
  expect(body.replaceAll("\u2060", "")).toBe(text);
  expect(body).toContain("ana@example.com");
  expect(await promptFor(text, "owner")).toBe(text);
});
