// A sandbox host on this machine, for tests and local runs: each sandbox is a bridge process on loopback with its own
// home directory as its files. Sleeping copies those files to a snapshot named by the sandbox id and removes them.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { BRIDGE_PORT } from "./launcher";
import { type ExecResult, SANDBOX_ID, type SandboxProvider } from "./provider";

const BRIDGE = join(import.meta.dir, "..", "sandbox", "bridge.ts");
/** The prompt files the sandbox image holds at /opt/tinycloud/prompts. */
const PROMPTS = join(import.meta.dir, "..", "..", "bots", "sandbox", "prompts");

interface Running {
  process: Subprocess<"ignore", "pipe", "inherit">;
  port: number;
  arm: number;
  touchedAt: number;
}

export interface ProviderEvent {
  operation: "create" | "wake" | "running" | "exec" | "endpoint" | "touch" | "sleep" | "destroy";
  id: string;
}

export class LocalProvider implements SandboxProvider {
  readonly #root: string;
  readonly #agent: string[];
  readonly #running = new Map<string, Running>();
  /** Sandboxes being saved: awake until their snapshot is written. */
  readonly #sleeping = new Map<string, Promise<void>>();
  /** Every call, in order, for tests and the local check's log. */
  readonly events: ProviderEvent[] = [];
  readonly #onEvent: (event: ProviderEvent) => void;

  /** `agent` is the command the bridge runs in place of OMP. */
  constructor(root: string, agent: string[], onEvent: (event: ProviderEvent) => void = () => {}) {
    this.#root = root;
    this.#agent = agent;
    this.#onEvent = onEvent;
  }

  #record(operation: ProviderEvent["operation"], id: string): void {
    if (!SANDBOX_ID.test(id)) throw new Error("invalid sandbox id");
    const event = { operation, id };
    this.events.push(event);
    this.#onEvent(event);
  }

  /** The sandbox's files while it is awake. */
  filesOf(id: string): string {
    return join(this.#root, "sandboxes", id);
  }

  snapshotOf(id: string): string {
    return join(this.#root, "snapshots", id);
  }

  isAwake(id: string): boolean {
    return this.#running.has(id) || this.#sleeping.has(id);
  }

  async acquire(id: string): Promise<void> {
    await this.#sleeping.get(id);
    if (this.#running.has(id)) {
      this.#record("running", id);
      this.#running.get(id)!.touchedAt = Date.now();
      return;
    }
    const files = this.filesOf(id);
    rmSync(files, { recursive: true, force: true });
    const snapshot = this.snapshotOf(id);
    const woke = existsSync(snapshot);
    if (woke) cpSync(snapshot, files, { recursive: true });
    else mkdirSync(files, { recursive: true });
    this.#record(woke ? "wake" : "create", id);
    const child = Bun.spawn(["bun", BRIDGE, ...this.#agent], {
      cwd: files,
      env: { PATH: process.env.PATH, HOME: files, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "0", ARM_PORT: "0", BOT_PROMPT_DIR: PROMPTS },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    // One reader for the bridge's whole life: it finds the ports, then keeps draining so the bridge never blocks on a
    // full pipe (leaving a for-await loop early would cancel the stream instead).
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let line: string | undefined;
    while (!line) {
      const { value, done } = await reader.read();
      if (done) throw new Error("bridge did not start");
      text += decoder.decode(value, { stream: true });
      line = text.split("\n").find(entry => entry.includes('"listening"'));
    }
    void (async () => { while (!(await reader.read()).done) { /* discard */ } })().catch(() => {});
    const ports = JSON.parse(line) as { port: number; arm: number };
    this.#running.set(id, { process: child, port: ports.port, arm: ports.arm, touchedAt: Date.now() });
  }

  async exec(id: string, command: string, env: Record<string, string>): Promise<ExecResult> {
    this.#record("exec", id);
    const running = this.#running.get(id);
    if (!running) throw new Error(`Sandbox ${id} is not running.`);
    const child = Bun.spawn(["sh", "-c", command], {
      cwd: this.filesOf(id),
      env: { PATH: process.env.PATH, HOME: this.filesOf(id), ARM_PORT: String(running.arm), ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, output: stdout + stderr };
  }

  async endpoint(id: string, port: number): Promise<string> {
    this.#record("endpoint", id);
    const running = this.#running.get(id);
    if (!running || port !== BRIDGE_PORT) throw new Error(`Sandbox ${id} is not running.`);
    return `http://127.0.0.1:${running.port}`;
  }

  async touch(id: string): Promise<void> {
    this.#record("touch", id);
    const running = this.#running.get(id);
    if (running) running.touchedAt = Date.now();
  }

  async sleep(id: string): Promise<void> {
    const running = this.#running.get(id);
    if (!running) return this.#sleeping.get(id);
    this.#record("sleep", id);
    this.#running.delete(id);
    const saved = (async () => {
      running.process.kill("SIGKILL");
      await running.process.exited;
      const snapshot = this.snapshotOf(id);
      rmSync(snapshot, { recursive: true, force: true });
      mkdirSync(join(this.#root, "snapshots"), { recursive: true });
      cpSync(this.filesOf(id), snapshot, { recursive: true });
      rmSync(this.filesOf(id), { recursive: true, force: true });
    })().finally(() => this.#sleeping.delete(id));
    this.#sleeping.set(id, saved);
    return saved;
  }

  /** What the host's sweeper does once a minute: sleep every sandbox nothing has touched for `idleMs`. */
  async sleepUnused(idleMs: number, now = Date.now()): Promise<void> {
    for (const [id, running] of [...this.#running]) if (now - running.touchedAt >= idleMs) await this.sleep(id);
  }

  async destroy(id: string): Promise<void> {
    this.#record("destroy", id);
    await this.#sleeping.get(id)?.catch(() => {});
    const running = this.#running.get(id);
    this.#running.delete(id);
    running?.process.kill("SIGKILL");
    await running?.process.exited;
    rmSync(this.filesOf(id), { recursive: true, force: true });
    rmSync(this.snapshotOf(id), { recursive: true, force: true });
  }

  /** Ends every bridge; files and snapshots stay. */
  async close(): Promise<void> {
    for (const id of [...this.#running.keys()]) await this.sleep(id);
  }
}
