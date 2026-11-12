// Starts and stops bot sandboxes with gVisor. Each sandbox: no network, its own in-memory root layer over the
// shared read-only bot rootfs (size-capped; held in sandbox memory, so it counts toward the memory limit), its own
// cgroup (memory, CPU, pids), its own state tmpfs (size- and inode-capped, saved to disk by state.ts), and only its
// own egress socket directory, read-only. `runsc run` stays in the foreground: the sandbox's stdio is OMP's RPC
// channel.

import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Sandbox, SandboxLauncher } from "./bot";
import type { SupervisorConfig } from "./config";
import { isRecord } from "./guards";
import type { BotLayout } from "./layout";
import { BOT_START, type OciSpec, SANDBOX_SESSION_DIR, sandboxSpec } from "./oci";
import { RpcChannel } from "./rpc";
import { COPY_FAILURES, type CopyFailure, hasSnapshot, STATE_INODES_PER_MB } from "./state";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_CONTROLLERS = ["cpu", "memory", "pids"];
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 15_000;
/** How long teardown lets `runsc run` finish on its own (OMP closed its output) before killing the sandbox. */
const EXIT_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 2000;
const STATE_COPY = join(import.meta.dir, "state-copy-main.ts");
/** Restores run in this cgroup below /bots, so the memory a restored state takes counts toward the bots' total. */
const RESTORE_CGROUP = "restore";

function log(event: string, botId: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ bots: event, bot: botId.slice(0, 12), ...extra }));
}

async function run(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${code}: ${stderr.slice(-300).trim()}`);
}

async function attempt(argv: string[]): Promise<boolean> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/**
 * Gets the container ready to run sandboxes without --privileged (see the compose file for the capability set):
 * - a private cgroup namespace (`cgroup: private`): /proc/self/cgroup must read "0::/", so the cgroup tree the
 *   supervisor writes is the container's own and never the CVM's;
 * - a writable cgroup2 mount, which Docker mounts read-only outside privileged mode;
 * - cgroup delegation: cgroup v2 only allows controllers below a cgroup with no member processes, so the
 *   supervisor moves itself into a leaf, enables cpu, memory and pids for the sandboxes' parent `/bots`, and caps
 *   that parent (all sandboxes together) at `totalMemoryMb` and `totalPids`;
 * - a leaf below that parent for state restores (`/bots/restore`), so restored state counts toward the total too.
 * Fails closed: without limits, no sandboxes.
 */
async function prepareHost(totalMemoryMb: number, totalPids: number): Promise<void> {
  const own = readFileSync("/proc/self/cgroup", "utf8").trim();
  if (own !== "0::/") throw new Error(`supervisor needs a private cgroup2 namespace (cgroup: private); /proc/self/cgroup is ${JSON.stringify(own)}`);
  try {
    accessSync(CGROUP_ROOT, constants.W_OK);
  } catch {
    await run(["mount", "-o", "remount,rw", CGROUP_ROOT]);
  }
  const available = readFileSync(join(CGROUP_ROOT, "cgroup.controllers"), "utf8").trim().split(/\s+/);
  const missing = CGROUP_CONTROLLERS.filter(controller => !available.includes(controller));
  if (missing.length > 0) throw new Error(`cgroup controllers unavailable: ${missing.join(", ")}`);
  const leaf = join(CGROUP_ROOT, "supervisor");
  mkdirSync(leaf, { recursive: true });
  for (const pid of readFileSync(join(CGROUP_ROOT, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) {
    try {
      writeFileSync(join(leaf, "cgroup.procs"), pid);
    } catch {
      // Exited meanwhile.
    }
  }
  const enable = CGROUP_CONTROLLERS.map(controller => `+${controller}`).join(" ");
  writeFileSync(join(CGROUP_ROOT, "cgroup.subtree_control"), enable);
  const bots = join(CGROUP_ROOT, "bots");
  mkdirSync(bots, { recursive: true });
  writeFileSync(join(bots, "cgroup.subtree_control"), enable);
  writeFileSync(join(bots, "memory.max"), String(totalMemoryMb * 1024 * 1024));
  if (existsSync(join(bots, "memory.swap.max"))) writeFileSync(join(bots, "memory.swap.max"), "0");
  writeFileSync(join(bots, "pids.max"), String(totalPids));
  mkdirSync(join(bots, RESTORE_CGROUP), { recursive: true });
}

/** OMP's provider config inside every sandbox: the model behind the bot's own egress socket. */
export function modelsYml(model: string): string {
  return [
    "# Written by the bots supervisor. The bot's only way out is its egress socket, bridged to 127.0.0.1:8080;",
    "# BOT_TOKEN is the bot's own gateway token, never a model key.",
    "providers:",
    "  tinycloud:",
    "    baseUrl: http://127.0.0.1:8080/v1",
    "    api: openai-completions",
    "    apiKey: BOT_TOKEN",
    "    models:",
    `      - id: ${JSON.stringify(model)}`,
    `        name: ${JSON.stringify(`TinyCloud (${model})`)}`,
    "        reasoning: false",
    "",
  ].join("\n");
}

/** A container's status as `runsc list` reports it; "absent" once runsc no longer knows it. */
export type RunscStatus = "created" | "running" | "paused" | "stopped" | "absent";

/**
 * One container's status from `runsc list -format=json` output. The whole list must check out first: `null` (no
 * containers) or an array of objects, each with a string id and a string status. Anything else, or a listed status
 * other than created, running, paused or stopped, is undefined (runsc cannot say), never "absent".
 */
export function listedStatus(output: string, containerId: string): RunscStatus | undefined {
  let listed: unknown;
  try {
    listed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (listed === null) return "absent";
  if (!Array.isArray(listed)) return undefined;
  const entries: { id: string; status: string }[] = [];
  for (const item of listed) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.status !== "string") return undefined;
    entries.push({ id: item.id, status: item.status });
  }
  const status = entries.find(entry => entry.id === containerId)?.status;
  if (status === undefined) return "absent";
  return status === "created" || status === "running" || status === "paused" || status === "stopped" ? status : undefined;
}

/** What ending one sandbox needs from the host; RunscHost passes runsc, the cgroup tree, the state copy and umount. */
export interface SandboxEnd {
  /** undefined when runsc cannot say. */
  status(): Promise<RunscStatus | undefined>;
  kill(): Promise<boolean>;
  remove(): Promise<boolean>;
  /** Kills the foreground `runsc run` process, if any, and waits for it. */
  reap(): Promise<void>;
  /** No process left in the sandbox's cgroup (or the cgroup is gone). */
  cgroupEmpty(): boolean;
  /** Saves the state to disk; logs its own failure. */
  save(): Promise<void>;
  unmount(): Promise<void>;
}

/**
 * Ends a sandbox, then confirms it is gone: killed if runsc listed it running, deleted by runsc (unless runsc no
 * longer knew it) and no longer listed, and no process left in its cgroup. Only then is its state saved (with
 * `save`) and its tmpfs unmounted. Unconfirmed, nothing is copied and the tmpfs stays mounted: the previous snapshot
 * stays, and the bot cannot start over a sandbox that may still write to it. Returns whether the end was confirmed.
 */
export async function endSandbox(end: SandboxEnd, botId: string, save: boolean): Promise<boolean> {
  const before = await end.status();
  const killed = before !== "running" || (await end.kill());
  const removed = before === "absent" || (await end.remove());
  await end.reap();
  const after = await end.status();
  const cgroupEmpty = end.cgroupEmpty();
  if (!killed || !removed || after !== "absent" || !cgroupEmpty) {
    log("teardown_unconfirmed", botId, { before: before ?? "unknown", killed, removed, after: after ?? "unknown", cgroupEmpty });
    if (save) log("snapshot_skipped", botId, { cause: "teardown_unconfirmed" });
    return false;
  }
  if (save) await end.save();
  await end.unmount();
  return true;
}

/**
 * Runs one state copy process. Returns its failure reason, "timeout" if it ran past `timeoutMs` (it is then
 * killed, then given a bounded wait to exit), or copier_leftover if exit remains unconfirmed.
 */
export async function runStateCopy(
  argv: string[], timeoutMs: number,
  onLeftover?: (exit: Promise<number>) => void,
  reapMs = 1000,
): Promise<CopyFailure | "timeout" | "copier_leftover" | undefined> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const finished = Promise.all([proc.exited, new Response(proc.stdout).text()]).then(([code, reason]) =>
    code === 0 ? undefined : (COPY_FAILURES.find(failure => failure === reason) ?? "io"),
  );
  const { promise: deadline, resolve } = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
    resolve("timeout");
  }, timeoutMs);
  try {
    const result = await Promise.race([finished, deadline]);
    if (result === "timeout") {
      let reapTimer: Timer | undefined;
      try {
        const reaped = await Promise.race([
          proc.exited.then(() => true),
          new Promise<false>(resolve => { reapTimer = setTimeout(() => resolve(false), reapMs); }),
        ]);
        if (!reaped) {
          onLeftover?.(proc.exited);
          return "copier_leftover";
        }
      } finally {
        clearTimeout(reapTimer);
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** An unreaped copier blocks later copies and deletion for its bot until its exit is confirmed. */
export class StateCopiers {
  readonly #leftovers = new Map<string, Promise<number>>();

  has(botId: string): boolean { return this.#leftovers.has(botId); }

  run(botId: string, argv: string[], timeoutMs: number, reapMs = 1000): ReturnType<typeof runStateCopy> {
    if (this.has(botId)) return Promise.resolve("copier_leftover");
    return runStateCopy(argv, timeoutMs, exit => {
      this.#leftovers.set(botId, exit);
      void exit.then(() => {
        if (this.#leftovers.get(botId) === exit) this.#leftovers.delete(botId);
      });
    }, reapMs);
  }
}

export interface MountEntry {
  target: string;
  type: string;
  /** Per-mount options (rw, nosuid, nodev, noexec, ...). */
  options: Set<string>;
}

/**
 * The mount `path` lives on, from /proc/self/mountinfo: the longest mount point that contains it, and of several
 * mounts there the last (the one on top).
 */
export function mountOf(path: string, mountinfo: string): MountEntry | undefined {
  let found: MountEntry | undefined;
  for (const line of mountinfo.split("\n")) {
    const [mount, superblock] = line.split(" - ");
    const fields = mount?.split(" ") ?? [];
    const target = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (!target || !fields[5] || !superblock) continue;
    if (target !== path && !path.startsWith(target === "/" ? "/" : `${target}/`)) continue;
    if (found && target.length < found.target.length) continue;
    found = { target, type: superblock.split(" ")[0] ?? "", options: new Set(fields[5].split(",")) };
  }
  return found;
}

const hasFlags = (mount: MountEntry | undefined, flags: string[]) => !!mount && flags.every(flag => mount.options.has(flag));

export function parseMountinfo(info: string): string[] {
  return info.split("\n").flatMap(line => {
    const point = line.split(" ")[4];
    return point ? [point.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))] : [];
  });
}

export class RunscHost implements SandboxLauncher {
  readonly #cfg: SupervisorConfig;
  #baseSpec: OciSpec | undefined;
  /** Bots whose last sandbox was not confirmed gone, and whether their tmpfs holds restored state to save. */
  readonly #leftovers = new Map<string, boolean>();
  /** Per bot, the state copy running or queued; one at a time, never rejecting. */
  readonly #copies = new Map<string, Promise<void>>();
  readonly #copiers = new StateCopiers();

  constructor(cfg: SupervisorConfig) {
    this.#cfg = cfg;
  }

  get #runsc(): string[] {
    return ["runsc", `--root=${this.#cfg.runscRoot}`, "--platform=systrap", "--network=none", "--host-uds=open"];
  }

  async init(): Promise<void> {
    await prepareHost(this.#cfg.totalMemoryMb, this.#cfg.totalPids);
    const agentDir = join(this.#cfg.rootfs, "root", ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.yml"), modelsYml(this.#cfg.model));
    for (const dir of [this.#cfg.dataRoot, this.#cfg.runRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Saved state never holds setuid files or devices (state.ts copies neither); its volume refuses both anyway.
    await run(["sh", "-c", 'mount -o remount,bind,nosuid,nodev "$(findmnt -n -o TARGET -T "$1")"', "sh", this.#cfg.dataRoot]);
    if (!hasFlags(mountOf(this.#cfg.dataRoot, readFileSync("/proc/self/mountinfo", "utf8")), ["nosuid", "nodev"])) {
      throw new Error("the data volume is not mounted nosuid,nodev");
    }
    const specDir = join(this.#cfg.runRoot, ".spec");
    rmSync(specDir, { recursive: true, force: true });
    mkdirSync(specDir);
    await run(["runsc", "spec", "--bundle", specDir, "--", BOT_START]);
    this.#baseSpec = JSON.parse(readFileSync(join(specDir, "config.json"), "utf8")) as OciSpec;
  }

  hasState(layout: BotLayout): boolean {
    return hasSnapshot(layout.stateSnapshot);
  }

  leftover(layout: BotLayout, sandboxOnly = false): boolean {
    return this.#leftovers.has(layout.botId) || (!sandboxOnly && this.#copiers.has(layout.botId));
  }

  mountPoints(): string[] {
    return parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"));
  }

  async launch(layout: BotLayout): Promise<Sandbox> {
    if (!this.#baseSpec) throw new Error("sandbox host not initialised");
    // A sandbox whose end was not confirmed still holds its tmpfs; end it first, or refuse to start over it.
    if (this.#copiers.has(layout.botId)) throw new Error("state copier exit unconfirmed");
    const leftover = this.#leftovers.get(layout.botId);
    if (leftover !== undefined && !(await this.#end(layout, leftover))) throw new Error("earlier sandbox not confirmed stopped");
    const token = randomBytes(32).toString("hex");
    let proc: Subprocess<"pipe", "pipe", "pipe"> | undefined;
    let teardown: Promise<void> | undefined;
    // Set once the tmpfs holds the restored state; only then is it saved. A failed restore leaves the snapshot as
    // it was.
    let restored = false;
    // A settled-turn copy runs with the sandbox paused, and resumes it however the copy ends.
    const snapshot = () =>
      this.#queue(layout.botId, async () => {
        if (teardown) return;
        if (!(await attempt([...this.#runsc, "pause", layout.containerId]))) {
          log("snapshot_skipped", layout.botId, { cause: "pause_failed" });
          return;
        }
        try {
          const failure = await this.#copy("save", layout.stateMount, layout.stateSnapshot, layout.botId);
          if (failure) log("snapshot_failed", layout.botId, { when: "settled", cause: failure });
        } finally {
          if (!teardown && !(await attempt([...this.#runsc, "resume", layout.containerId]))) {
            log("resume_failed", layout.botId);
            void destroy();
          }
        }
      });
    const destroy = () =>
      (teardown ??= (async () => {
        await Promise.race([proc?.exited, Bun.sleep(EXIT_GRACE_MS)]);
        await this.#end(layout, restored, proc);
        await this.#control("DELETE", layout.botId).catch(() => {});
      })());
    try {
      await this.#mountState(layout);
      restored = true;
      await this.#control("PUT", layout.botId, token);
      const spec = sandboxSpec(this.#baseSpec, {
        rootfs: this.#cfg.rootfs,
        token,
        egressDir: layout.egressDir,
        stateMount: layout.stateMount,
        cgroupsPath: `/bots/${layout.botId}`,
        limits: this.#cfg.limits,
      });
      writeFileSync(join(layout.bundleDir, "config.json"), JSON.stringify(spec), { mode: 0o600 });
      await attempt([...this.#runsc, "delete", "-force", layout.containerId]);
      proc = Bun.spawn(
        [...this.#runsc, `--overlay2=root:memory,size=${this.#cfg.limits.overlayMb}m`, "run", "--bundle", layout.bundleDir, layout.containerId],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const child = proc;
      let stderr = "";
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
      })();
      const rpc = new RpcChannel(line => {
        child.stdin.write(line);
        void child.stdin.flush();
      }, child.stdout);
      // A broken protocol (or closed output) ends the sandbox. Both settle even if the teardown fails; stop()
      // reports that.
      void rpc.closed.then(() => destroy()).catch(() => {});
      const exited = child.exited.then(() => destroy()).catch(() => {});
      try {
        await rpc.ready(READY_TIMEOUT_MS);
        await rpc.request({ type: "set_event_filter", events: ["message_update", "message_end"], messageUpdates: "delta" });
        await rpc.request(
          { type: "open_session", sessionDir: SANDBOX_SESSION_DIR, provider: "tinycloud", modelId: this.#cfg.model },
          READY_TIMEOUT_MS,
        );
      } catch (error) {
        log("sandbox_stderr", layout.botId, { stderr });
        throw error;
      }
      let stopping: Promise<void> | undefined;
      return {
        nextId: () => rpc.nextId(),
        request: (command, timeoutMs) => rpc.request(command, timeoutMs),
        onFrame: listener => rpc.onFrame(listener),
        exited,
        refreshEgress: () => this.#control("PUT", layout.botId, token),
        snapshot,
        stop: () =>
          (stopping ??= (async () => {
            // Closing stdin lets OMP drain and exit; a sandbox that ignores it is killed.
            try {
              child.stdin.end();
            } catch {
              // Already closed.
            }
            await Promise.race([child.exited, Bun.sleep(STOP_GRACE_MS)]);
            await destroy();
          })()),
      };
    } catch (error) {
      await destroy().catch(() => {});
      throw error;
    }
  }

  /** A fresh tmpfs at stateMount (size- and inode-capped, nosuid, nodev, noexec) holding the restored state. */
  async #mountState(layout: BotLayout): Promise<void> {
    mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(layout.stateMount, { recursive: true, mode: 0o700 });
    if (await attempt(["mountpoint", "-q", layout.stateMount])) throw new Error("state tmpfs still mounted");
    const { stateMb } = this.#cfg.limits;
    const options = `size=${stateMb}m,nr_inodes=${stateMb * STATE_INODES_PER_MB},mode=0700,uid=0,gid=0,nosuid,nodev,noexec`;
    await run(["mount", "-t", "tmpfs", "-o", options, "tmpfs", layout.stateMount]);
    const mount = mountOf(layout.stateMount, readFileSync("/proc/self/mountinfo", "utf8"));
    if (mount?.target !== layout.stateMount || mount.type !== "tmpfs" || !hasFlags(mount, ["nosuid", "nodev", "noexec"])) {
      throw new Error("state tmpfs not mounted nosuid,nodev,noexec");
    }
    const failure = await this.#copy("restore", layout.stateSnapshot, layout.stateMount, layout.botId);
    if (failure) throw new Error(`state restore failed: ${failure}`);
  }

  /** Ends the bot's sandbox (see endSandbox) and remembers an unconfirmed end for its next start. */
  async #end(layout: BotLayout, save: boolean, proc?: Subprocess): Promise<boolean> {
    const id = layout.containerId;
    const confirmed = await endSandbox(
      {
        status: () => this.#status(id),
        kill: () => attempt([...this.#runsc, "kill", id, "KILL"]),
        remove: () => attempt([...this.#runsc, "delete", "-force", id]),
        reap: async () => {
          proc?.kill("SIGKILL");
          await proc?.exited;
        },
        cgroupEmpty: () => {
          try {
            return /^populated 0$/m.test(readFileSync(join(CGROUP_ROOT, "bots", layout.botId, "cgroup.events"), "utf8"));
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT";
          }
        },
        save: () =>
          this.#queue(layout.botId, async () => {
            const failure = await this.#copy("save", layout.stateMount, layout.stateSnapshot, layout.botId);
            if (failure) log("snapshot_failed", layout.botId, { when: "stop", cause: failure });
          }),
        unmount: async () => {
          if (this.#copiers.has(layout.botId)) throw new Error("state copier exit unconfirmed");
          if (await attempt(["umount", layout.stateMount])) return;
          const lazy = await attempt(["umount", "-l", layout.stateMount]);
          log("unmount_failed", layout.botId, { lazy });
        },
      },
      layout.botId,
      save,
    );
    if (confirmed) this.#leftovers.delete(layout.botId);
    else this.#leftovers.set(layout.botId, save);
    return confirmed;
  }

  /** The container's status from `runsc list`; undefined when runsc cannot say. */
  async #status(containerId: string): Promise<RunscStatus | undefined> {
    const proc = Bun.spawn([...this.#runsc, "list", "-format=json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return code === 0 ? listedStatus(out, containerId) : undefined;
  }

  /** Runs `job` after the bot's earlier copies; the chain never rejects. */
  #queue(botId: string, job: () => Promise<void>): Promise<void> {
    const next = (this.#copies.get(botId) ?? Promise.resolve()).then(job).catch(() => log("snapshot_failed", botId, { cause: "io" }));
    this.#copies.set(botId, next);
    void next.then(() => {
      if (this.#copies.get(botId) === next) this.#copies.delete(botId);
    });
    return next;
  }

  /**
   * Runs one state copy in its own process (state-copy-main.ts), killed past BOTS_STATE_COPY_TIMEOUT_MS, and returns
   * why it failed, if it did. A restore runs in /bots/restore, so the memory the restored state takes counts toward
   * the bots' total.
   */
  #copy(command: "save" | "restore", from: string, to: string, botId: string): ReturnType<typeof runStateCopy> {
    const argv = [process.execPath, STATE_COPY, command, from, to, String(this.#cfg.limits.stateMb)];
    const procs = join(CGROUP_ROOT, "bots", RESTORE_CGROUP, "cgroup.procs");
    return this.#copiers.run(botId, command === "restore" ? ["sh", "-c", 'echo $$ > "$0" && exec "$@"', procs, ...argv] : argv, this.#cfg.stateCopyTimeoutMs);
  }

  /** The gateway's control socket: register (PUT) or drop (DELETE) one bot's egress socket and token. */
  async #control(method: "PUT" | "DELETE", botId: string, token?: string): Promise<void> {
    const response = await fetch(`http://gateway/bots/${botId}`, {
      unix: join(this.#cfg.egressRoot, "control.sock"),
      method,
      headers: { "content-type": "application/json" },
      body: token ? JSON.stringify({ token }) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`gateway ${method} failed: ${response.status}`);
  }
}
