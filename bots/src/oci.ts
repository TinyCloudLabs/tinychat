// OCI runtime spec for one bot sandbox, derived from `runsc spec` output (the jq step of the spike, in TS).

import type { SandboxLimits } from "./config";

export interface OciMount {
  destination: string;
  type: string;
  source: string;
  options?: string[];
}

export interface OciSpec {
  ociVersion?: string;
  process: Record<string, unknown> & { env?: string[]; args?: string[] };
  root: { path: string; readonly?: boolean };
  hostname?: string;
  mounts: OciMount[];
  linux?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Inside the sandbox: the owner's persistent state and the directory holding its egress socket. */
export const SANDBOX_STATE_DIR = "/root/bot";
export const SANDBOX_EGRESS_DIR = "/run/egress";
export const SANDBOX_SESSION_DIR = `${SANDBOX_STATE_DIR}/sessions/main`;
export const BOT_START = "/usr/local/bin/bot-start.sh";

export interface SandboxSpecInput {
  /** Shared read-only lower layer; runsc gives each sandbox its own in-memory upper layer. */
  rootfs: string;
  token: string;
  /** The bot's own egress directory (only its socket), mounted read-only. */
  egressDir: string;
  /** The bot's own state filesystem, mounted read-write. */
  stateMount: string;
  cgroupsPath: string;
  limits: SandboxLimits;
}

const CPU_PERIOD_US = 100_000;

export function sandboxSpec(base: OciSpec, input: SandboxSpecInput): OciSpec {
  const memoryBytes = input.limits.memoryMb * 1024 * 1024;
  return {
    ...base,
    hostname: "main",
    // Not readonly: runsc only overlays writable roots, and the overlay (not the host directory) takes the writes.
    root: { path: input.rootfs, readonly: false },
    process: {
      ...base.process,
      terminal: false,
      cwd: "/root",
      user: { uid: 0, gid: 0 },
      args: [BOT_START],
      env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME=/root",
        `BOT_TOKEN=${input.token}`,
        "PI_NO_TITLE=1",
      ],
      noNewPrivileges: true,
    },
    // runsc's defaults are proc, a /dev tmpfs and a read-only sysfs. On top: a capped /tmp (runsc would otherwise
    // add an uncapped one) and exactly two binds, the bot's own egress directory and state filesystem.
    mounts: [
      ...base.mounts.filter(mount => mount.type !== "bind" && mount.destination !== "/tmp"),
      { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["nosuid", "nodev", `size=${input.limits.tmpMb}m`] },
      { destination: SANDBOX_EGRESS_DIR, type: "bind", source: input.egressDir, options: ["rbind", "ro", "nosuid", "nodev", "noexec"] },
      { destination: SANDBOX_STATE_DIR, type: "bind", source: input.stateMount, options: ["rbind", "rw", "nosuid", "nodev"] },
    ],
    linux: {
      ...base.linux,
      cgroupsPath: input.cgroupsPath,
      resources: {
        memory: { limit: memoryBytes, swap: memoryBytes },
        cpu: { quota: input.limits.cpus * CPU_PERIOD_US, period: CPU_PERIOD_US },
        pids: { limit: input.limits.pids },
      },
    },
  };
}
