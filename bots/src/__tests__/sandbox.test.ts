import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endSandbox, mountOf, type RunscStatus, runStateCopy, type SandboxEnd } from "../sandbox";
import { saveSnapshot, stateLimits } from "../state";

describe("ending a sandbox", () => {
  let root: string;
  let mount: string;
  let state: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bots-end-"));
    mount = join(root, "mount");
    state = join(root, "bot", "state");
    mkdirSync(mount);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "note"), "previous");
    writeFileSync(join(mount, "note"), "live");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A host whose runsc answers as told; saving copies the "tmpfs" for real, so the snapshot shows what happened. */
  function host(statuses: (RunscStatus | undefined)[], answers: { kill?: boolean; remove?: boolean; cgroupEmpty?: boolean } = {}) {
    const calls: string[] = [];
    const end: SandboxEnd = {
      status: async () => {
        calls.push("status");
        return statuses.shift();
      },
      kill: async () => {
        calls.push("kill");
        return answers.kill ?? true;
      },
      remove: async () => {
        calls.push("remove");
        return answers.remove ?? true;
      },
      reap: async () => {
        calls.push("reap");
      },
      cgroupEmpty: () => answers.cgroupEmpty ?? true,
      save: async () => {
        calls.push("save");
        saveSnapshot(mount, state, stateLimits(16));
      },
      unmount: async () => {
        calls.push("unmount");
      },
    };
    return { end, calls };
  }

  test("kill and delete failing with processes left: no copy, the tmpfs stays mounted, the previous snapshot is unchanged", async () => {
    const { end, calls } = host(["running", "running"], { kill: false, remove: false, cgroupEmpty: false });
    expect(await endSandbox(end, "a".repeat(64), true)).toBe(false);
    expect(calls).toEqual(["status", "kill", "remove", "reap", "status"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("previous");
  });

  test("a failed kill is unconfirmed even when runsc then lists nothing", async () => {
    const { end, calls } = host(["running", "absent"], { kill: false });
    expect(await endSandbox(end, "a".repeat(64), true)).toBe(false);
    expect(calls).toEqual(["status", "kill", "remove", "reap", "status"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("previous");
  });

  test("a sandbox runsc already removed needs no kill or delete", async () => {
    const { end, calls } = host(["absent", "absent"]);
    expect(await endSandbox(end, "a".repeat(64), true)).toBe(true);
    expect(calls).toEqual(["status", "reap", "status", "save", "unmount"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("live");
  });

  test("still listed, or a process left in its cgroup: unconfirmed, no copy", async () => {
    for (const { statuses, cgroupEmpty } of [
      { statuses: ["running", "stopped"] as RunscStatus[], cgroupEmpty: true },
      { statuses: ["running", "absent"] as RunscStatus[], cgroupEmpty: false },
      { statuses: [undefined, undefined], cgroupEmpty: true },
    ]) {
      const { end, calls } = host(statuses, { cgroupEmpty });
      expect(await endSandbox(end, "a".repeat(64), true)).toBe(false);
      expect(calls).not.toContain("save");
      expect(calls).not.toContain("unmount");
    }
    expect(readFileSync(join(state, "note"), "utf8")).toBe("previous");
  });

  test("confirmed gone: the state is saved, then the tmpfs unmounted", async () => {
    const { end, calls } = host(["running", "absent"]);
    expect(await endSandbox(end, "a".repeat(64), true)).toBe(true);
    expect(calls).toEqual(["status", "kill", "remove", "reap", "status", "save", "unmount"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("live");
  });

  test("a sandbox that already stopped is not killed; deleting it confirms the end", async () => {
    const { end, calls } = host(["stopped", "absent"]);
    expect(await endSandbox(end, "a".repeat(64), false)).toBe(true);
    expect(calls).toEqual(["status", "remove", "reap", "status", "unmount"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("previous");
  });
});

describe("state copy process", () => {
  test("a stalled copier is killed at the deadline and reported as timeout", async () => {
    const started = Date.now();
    expect(await runStateCopy(["sleep", "30"], 200)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("the copier's printed reason is kept only when it is a known one", async () => {
    expect(await runStateCopy(["true"], 5000)).toBeUndefined();
    expect(await runStateCopy(["sh", "-c", "printf too_large; exit 1"], 5000)).toBe("too_large");
    expect(await runStateCopy(["sh", "-c", "printf 'anything else'; exit 1"], 5000)).toBe("io");
  });
});

describe("mountinfo", () => {
  const mountinfo = [
    "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/x",
    "30 22 8:1 /volumes/bot-data/_data /data rw,relatime - ext4 /dev/sda1 rw",
    "31 30 8:1 /volumes/bot-data/_data /data rw,nosuid,nodev,relatime - ext4 /dev/sda1 rw",
    "40 22 0:50 / /run/bots/abc/state rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=262144k,nr_inodes=16384,mode=700",
    "41 22 0:51 / /run/with\\040space rw - tmpfs tmpfs rw",
  ].join("\n");

  test("finds the mount a path lives on, the top one where several are stacked", () => {
    const data = mountOf("/data/bots", mountinfo);
    expect(data?.target).toBe("/data");
    expect([...(data?.options ?? [])]).toContain("nosuid");
    const state = mountOf("/run/bots/abc/state", mountinfo);
    expect(state?.type).toBe("tmpfs");
    expect(["nosuid", "nodev", "noexec"].every(flag => state?.options.has(flag))).toBe(true);
    expect(mountOf("/run/bots/abc", mountinfo)?.target).toBe("/");
    expect(mountOf("/run/with space/x", mountinfo)?.target).toBe("/run/with space");
  });
});
