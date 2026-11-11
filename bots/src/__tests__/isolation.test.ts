import { describe, expect, test } from "bun:test";
import { type BotLayout, botLayout, egressPaths } from "../layout";
import { type OciSpec, sandboxSpec } from "../oci";
import { botIdFor } from "../owner";

const roots = { dataRoot: "/data/bots", runRoot: "/run/bots", egressRoot: "/egress" };
const A = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const B = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
const limits = { memoryMb: 1536, cpus: 1, pids: 256, overlayMb: 512, tmpMb: 256, stateMb: 256 };

/** What `runsc spec` writes (release 20261102.0), plus a bind a future default might add. */
const base: OciSpec = {
  ociVersion: "1.0.0",
  process: { user: { uid: 0, gid: 0 }, args: ["sh"], env: ["PATH=/bin", "TERM=xterm"], cwd: "/" },
  root: { path: "rootfs", readonly: true },
  hostname: "runsc",
  mounts: [
    { destination: "/proc", type: "proc", source: "proc" },
    { destination: "/dev", type: "tmpfs", source: "tmpfs" },
    { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
    { destination: "/var/run", type: "bind", source: "/var/run", options: ["rbind"] },
  ],
  linux: { namespaces: [{ type: "pid" }, { type: "network" }, { type: "ipc" }, { type: "uts" }, { type: "mount" }] },
};

function specFor(owner: string, token: string) {
  const layout = botLayout(botIdFor(owner), roots);
  const spec = sandboxSpec(base, {
    rootfs: "/bot-rootfs",
    token,
    egressDir: layout.egressDir,
    stateMount: layout.stateMount,
    cgroupsPath: `/bots/${layout.botId}`,
    limits,
  });
  return { layout, spec };
}

const pathsOf = (layout: BotLayout) => [
  layout.dataDir,
  layout.stateImage,
  layout.bundleDir,
  layout.stateMount,
  layout.egressDir,
  layout.socketPath,
];

describe("owner to bot isolation", () => {
  test("two owners never share a bot id, directory, socket, container or cgroup", () => {
    const a = specFor(A, "1".repeat(64));
    const b = specFor(B, "2".repeat(64));
    expect(a.layout.botId).not.toBe(b.layout.botId);
    expect(a.layout.containerId).not.toBe(b.layout.containerId);
    for (const path of pathsOf(a.layout)) {
      for (const other of pathsOf(b.layout)) expect(other.startsWith(path) || path.startsWith(other)).toBe(false);
    }
    expect(a.spec.linux?.cgroupsPath).not.toBe(b.spec.linux?.cgroupsPath);
    const tokenOf = (spec: OciSpec) => spec.process.env?.find(entry => entry.startsWith("BOT_TOKEN="));
    expect(tokenOf(a.spec)).toBe(`BOT_TOKEN=${"1".repeat(64)}`);
    expect(JSON.stringify(a.spec)).not.toContain(b.layout.botId);
    expect(JSON.stringify(a.spec)).not.toContain("2".repeat(64));
  });

  test("the same owner always maps to the same bot", () => {
    expect(botIdFor(A)).toBe(botIdFor(A));
    expect(botIdFor(A)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("paths come from the hash only, never the DID, and stay under their roots", () => {
    const { layout } = specFor(A, "1".repeat(64));
    for (const path of pathsOf(layout)) {
      expect(path).not.toContain("did:");
      expect(path).not.toContain("0x");
      expect(Object.values(roots).some(root => path.startsWith(`${root}/${layout.botId}`))).toBe(true);
    }
    for (const bad of ["../../etc", `${"a".repeat(63)}/`, "A".repeat(64), A, ""]) {
      expect(() => botLayout(bad, roots)).toThrow();
      expect(() => egressPaths("/egress", bad)).toThrow();
    }
  });
});

describe("sandbox mounts", () => {
  test("exactly the runsc defaults, a capped /tmp, and the bot's own egress (read-only) and state (read-write)", () => {
    const { layout, spec } = specFor(A, "1".repeat(64));
    expect(spec.mounts).toEqual([
      { destination: "/proc", type: "proc", source: "proc" },
      { destination: "/dev", type: "tmpfs", source: "tmpfs" },
      { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
      { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["nosuid", "nodev", "size=256m"] },
      {
        destination: "/run/egress",
        type: "bind",
        source: `/egress/${layout.botId}`,
        options: ["rbind", "ro", "nosuid", "nodev", "noexec"],
      },
      { destination: "/root/bot", type: "bind", source: `/run/bots/${layout.botId}/state`, options: ["rbind", "rw", "nosuid", "nodev"] },
    ]);
    // The egress mount is the bot's own directory, never the shared volume root holding the control socket.
    expect(spec.mounts.some(mount => mount.source === roots.egressRoot || mount.source === "/run")).toBe(false);
  });

  test("limits and process settings", () => {
    const { spec } = specFor(A, "1".repeat(64));
    expect(spec.root).toEqual({ path: "/bot-rootfs", readonly: false });
    expect(spec.process.args).toEqual(["/usr/local/bin/bot-start.sh"]);
    expect(spec.process.terminal).toBe(false);
    expect(spec.process.noNewPrivileges).toBe(true);
    expect(spec.process.env?.some(entry => /REDPILL|SERVICE_SECRET/.test(entry))).toBe(false);
    expect(spec.linux?.resources).toEqual({
      memory: { limit: 1536 * 1024 * 1024, swap: 1536 * 1024 * 1024 },
      cpu: { quota: 100_000, period: 100_000 },
      pids: { limit: 256 },
    });
  });
});
