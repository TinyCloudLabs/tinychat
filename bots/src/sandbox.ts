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
import type { BotLayout } from "./layout";
import { BOT_START, type OciSpec, SANDBOX_SESSION_DIR, sandboxSpec } from "./oci";
import { RpcChannel } from "./rpc";
import { COPY_FAILURES, type CopyFailure, hasSnapshot, STATE_INODES_PER_MB } from "./state";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_CONTROLLERS = ["cpu", "memory", "pids"];
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 15_000;
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

export class RunscHost implements SandboxLauncher {
  readonly #cfg: SupervisorConfig;
  #baseSpec: OciSpec | undefined;

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
    const specDir = join(this.#cfg.runRoot, ".spec");
    rmSync(specDir, { recursive: true, force: true });
    mkdirSync(specDir);
    await run(["runsc", "spec", "--bundle", specDir, "--", BOT_START]);
    this.#baseSpec = JSON.parse(readFileSync(join(specDir, "config.json"), "utf8")) as OciSpec;
  }

  hasState(layout: BotLayout): boolean {
    return hasSnapshot(layout.stateSnapshot);
  }

  async launch(layout: BotLayout): Promise<Sandbox> {
    if (!this.#baseSpec) throw new Error("sandbox host not initialised");
    const token = randomBytes(32).toString("hex");
    let proc: Subprocess<"pipe", "pipe", "pipe"> | undefined;
    let teardown: Promise<void> | undefined;
    // Set once the tmpfs holds the restored state; only then is it saved. A failed restore leaves the snapshot as
    // it was.
    let restored = false;
    // One copy at a time: a settled-turn copy runs with the sandbox paused, the stop copy after it has exited. The
    // chain never rejects.
    let saving = Promise.resolve();
    const save = (when: "settled" | "stop") =>
      (saving = saving
        .then(async () => {
          if (when === "settled") {
            if (teardown) return;
            if (!(await attempt([...this.#runsc, "pause", layout.containerId]))) {
              log("snapshot_skipped", layout.botId, { cause: "pause_failed" });
              return;
            }
          }
          try {
            const failure = await this.#copy("save", layout.stateMount, layout.stateSnapshot);
            if (failure) log("snapshot_failed", layout.botId, { when, cause: failure });
          } finally {
            if (when === "settled" && !teardown && !(await attempt([...this.#runsc, "resume", layout.containerId]))) {
              log("resume_failed", layout.botId);
              void destroy();
            }
          }
        })
        .catch(() => log("snapshot_failed", layout.botId, { when, cause: "io" })));
    const destroy = () =>
      (teardown ??= (async () => {
        await attempt([...this.#runsc, "kill", layout.containerId, "KILL"]);
        await attempt([...this.#runsc, "delete", "-force", layout.containerId]);
        proc?.kill("SIGKILL");
        await proc?.exited;
        if (restored) await save("stop");
        if (!(await attempt(["umount", layout.stateMount]))) {
          const lazy = await attempt(["umount", "-l", layout.stateMount]);
          log("unmount_failed", layout.botId, { lazy });
        }
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
      // A broken protocol (or closed output) ends the sandbox.
      void rpc.closed.then(() => destroy());
      const exited = child.exited.then(() => destroy());
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
        snapshot: () => save("settled"),
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
      await destroy();
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
    const failure = await this.#copy("restore", layout.stateSnapshot, layout.stateMount);
    if (failure) throw new Error(`state restore failed: ${failure}`);
  }

  /**
   * Runs one state copy in its own process (state-copy-main.ts) and returns why it failed, if it did. A restore runs
   * in /bots/restore, so the memory the restored state takes counts toward the bots' total.
   */
  async #copy(command: "save" | "restore", from: string, to: string): Promise<CopyFailure | undefined> {
    const argv = [process.execPath, STATE_COPY, command, from, to, String(this.#cfg.limits.stateMb)];
    const procs = join(CGROUP_ROOT, "bots", RESTORE_CGROUP, "cgroup.procs");
    const proc = Bun.spawn(command === "restore" ? ["sh", "-c", 'echo $$ > "$0" && exec "$@"', procs, ...argv] : argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [code, reason] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code === 0) return undefined;
    return COPY_FAILURES.find(failure => failure === reason) ?? "io";
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
