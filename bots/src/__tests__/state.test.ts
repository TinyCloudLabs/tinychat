import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CopyError,
  type CopyLimits,
  copyTree,
  hasSnapshot,
  openSnapshot,
  type RecoverySteps,
  recoverSnapshot,
  saveSnapshot,
} from "../state";

const LIMITS: CopyLimits = { maxBytes: 1024 * 1024, maxEntries: 100 };
let root: string;
let src: string;
let dst: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bots-state-"));
  src = join(root, "src");
  dst = join(root, "dst");
  outside = join(root, "outside");
  for (const dir of [src, dst, outside]) mkdirSync(dir);
  writeFileSync(join(outside, "keep"), "outside");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const reasonOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return error instanceof CopyError ? error.reason : "other error";
  }
  return "copied";
};

/** Everything under `dir` as relative paths, without following symlinks, to show nothing appeared where it should not. */
function listing(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .flatMap(name => {
      const path = join(dir, name);
      return [prefix + name, ...(lstatSync(path).isDirectory() ? listing(path, `${prefix}${name}/`) : [])];
    })
    .sort();
}

describe("copyTree", () => {
  test("copies directories, files and symlinks; follows no symlink and writes nothing outside the destination", () => {
    writeFileSync(join(src, "note"), "hello");
    utimesSync(join(src, "note"), 1_700_000_000, 1_700_000_000);
    mkdirSync(join(src, "dir"));
    writeFileSync(join(src, "dir", "inner"), "inner");
    symlinkSync("/etc", join(src, "etc"));
    symlinkSync("..", join(src, "up"));
    symlinkSync(outside, join(src, "out"));
    symlinkSync("../../outside/keep", join(src, "dir", "escape"));
    const before = { outside: listing(outside), root: readdirSync(root).sort() };

    copyTree(src, dst, LIMITS, true);

    expect(readFileSync(join(dst, "note"), "utf8")).toBe("hello");
    expect(statSync(join(dst, "note")).mtimeMs).toBe(1_700_000_000_000);
    expect(readFileSync(join(dst, "dir", "inner"), "utf8")).toBe("inner");
    for (const [name, target] of [
      ["etc", "/etc"],
      ["up", ".."],
      ["out", outside],
      ["dir/escape", "../../outside/keep"],
    ]) {
      expect(lstatSync(join(dst, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dst, name))).toBe(target);
    }
    expect(listing(dst)).toEqual(["dir", "dir/escape", "dir/inner", "etc", "note", "out", "up"]);
    expect({ outside: listing(outside), root: readdirSync(root).sort() }).toEqual(before);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  });

  test("a symlink in place of the source directory is refused, not followed", () => {
    const link = join(root, "link");
    symlinkSync(outside, link);
    expect(reasonOf(() => copyTree(link, dst, LIMITS, false))).toBe("io");
    expect(listing(dst)).toEqual([]);
  });

  test("drops setuid, setgid and sticky bits; directories become 0700; no xattrs", () => {
    writeFileSync(join(src, "suid"), "x");
    chmodSync(join(src, "suid"), 0o4755);
    writeFileSync(join(src, "sgid"), "x");
    chmodSync(join(src, "sgid"), 0o2640);
    mkdirSync(join(src, "sticky"));
    chmodSync(join(src, "sticky"), 0o1777);
    const python = Bun.which("python3");
    if (python) {
      const set = Bun.spawnSync([python, "-c", "import os, sys; os.setxattr(sys.argv[1], 'user.planted', b'1')", join(src, "suid")]);
      expect(set.exitCode).toBe(0);
    }

    copyTree(src, dst, LIMITS, false);

    expect(statSync(join(dst, "suid")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(dst, "sgid")).mode & 0o7777).toBe(0o640);
    expect(statSync(join(dst, "sticky")).mode & 0o7777).toBe(0o700);
    if (python) {
      const list = Bun.spawnSync([python, "-c", "import os, sys; print(os.listxattr(sys.argv[1]))", join(dst, "suid")]);
      expect(list.stdout.toString().trim()).toBe("[]");
    }
  });

  test("a FIFO or a socket stops the copy as special_file", async () => {
    mkdirSync(join(src, "a"));
    expect(Bun.spawnSync(["mkfifo", join(src, "a", "fifo")]).exitCode).toBe(0);
    expect(reasonOf(() => copyTree(src, dst, LIMITS, false))).toBe("special_file");

    rmSync(join(src, "a", "fifo"));
    rmSync(dst, { recursive: true });
    mkdirSync(dst);
    const server = Bun.listen({ unix: join(src, "a", "sock"), socket: { data() {} } });
    try {
      expect(lstatSync(join(src, "a", "sock")).isSocket()).toBe(true);
      expect(reasonOf(() => copyTree(src, dst, LIMITS, false))).toBe("special_file");
    } finally {
      server.stop(true);
    }
  });

  test("stops past the byte, entry and depth caps, and refuses a destination that is not empty", () => {
    writeFileSync(join(src, "big"), Buffer.alloc(10_000));
    expect(reasonOf(() => copyTree(src, dst, { maxBytes: 8192, maxEntries: 100 }, false))).toBe("too_large");

    rmSync(join(src, "big"));
    rmSync(dst, { recursive: true });
    mkdirSync(dst);
    for (const name of ["a", "b", "c"]) writeFileSync(join(src, name), "");
    expect(reasonOf(() => copyTree(src, dst, { maxBytes: 1024 * 1024, maxEntries: 2 }, false))).toBe("too_many_files");

    rmSync(src, { recursive: true });
    rmSync(dst, { recursive: true });
    mkdirSync(join(src, ...Array<string>(65).fill("d")), { recursive: true });
    mkdirSync(dst);
    expect(reasonOf(() => copyTree(src, dst, LIMITS, false))).toBe("too_deep");

    rmSync(src, { recursive: true });
    mkdirSync(src);
    expect(reasonOf(() => copyTree(src, dst, LIMITS, false))).toBe("io");
  });
});

describe("snapshot swap", () => {
  let state: string;
  const fresh = () => `${state}.new`;
  const old = () => `${state}.old`;
  /** A tree the bot made, with a symlink out of it: removing the tree must not follow it. */
  const botTree = (dir: string, note: string) => {
    mkdirSync(dir);
    writeFileSync(join(dir, "note"), note);
    symlinkSync(outside, join(dir, "out"));
  };

  beforeEach(() => {
    state = join(root, "bot", "state");
    mkdirSync(join(root, "bot"));
  });

  test("a first start creates an empty snapshot; saves replace it and leave no state.new or state.old", () => {
    expect(hasSnapshot(state)).toBe(false);
    openSnapshot(state);
    expect(listing(state)).toEqual([]);
    expect(hasSnapshot(state)).toBe(true);

    writeFileSync(join(src, "note"), "v1");
    saveSnapshot(src, state, LIMITS);
    writeFileSync(join(src, "note"), "v2");
    saveSnapshot(src, state, LIMITS);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v2");
    expect(readdirSync(join(root, "bot"))).toEqual(["state"]);
  });

  test("a failed save keeps the previous snapshot", () => {
    botTree(state, "v1");
    expect(Bun.spawnSync(["mkfifo", join(src, "fifo")]).exitCode).toBe(0);
    expect(reasonOf(() => saveSnapshot(src, state, LIMITS))).toBe("special_file");
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v1");
    expect(readdirSync(join(root, "bot"))).toEqual(["state"]);
  });

  test("crash while writing state.new: state stays, state.new goes", () => {
    botTree(state, "v1");
    botTree(fresh(), "partial");
    recoverSnapshot(state);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v1");
    expect(existsSync(fresh())).toBe(false);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  });

  test("crash between the two renames: the complete state.new becomes state, state.old goes", () => {
    botTree(old(), "v1");
    botTree(fresh(), "v2");
    expect(hasSnapshot(state)).toBe(true);
    recoverSnapshot(state);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v2");
    expect(readdirSync(join(root, "bot"))).toEqual(["state"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  });

  test("crash after the swap, before state.old is removed: state stays, state.old goes", () => {
    botTree(state, "v2");
    botTree(old(), "v1");
    recoverSnapshot(state);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v2");
    expect(readdirSync(join(root, "bot"))).toEqual(["state"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  });

  test("only state.old left: it becomes state again", () => {
    botTree(old(), "v1");
    recoverSnapshot(state);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v1");
    expect(readdirSync(join(root, "bot"))).toEqual(["state"]);
  });

  test("recovery syncs the directory before it removes anything, on every branch", () => {
    const record = () => {
      const ops: string[] = [];
      const steps: RecoverySteps = {
        rename: (from, to) => {
          ops.push(`rename ${basename(from)} ${basename(to)}`);
          renameSync(from, to);
        },
        remove: path => {
          ops.push(`remove ${basename(path)}`);
          rmSync(path, { recursive: true, force: true });
        },
        sync: dir => {
          ops.push(`sync ${basename(dir)}`);
        },
      };
      return { ops, steps };
    };

    // A crash right after state.new became state: state, state.old and a stray state.new.
    botTree(state, "v2");
    botTree(old(), "v1");
    botTree(fresh(), "partial");
    const present = record();
    recoverSnapshot(state, present.steps);
    expect(present.ops).toEqual(["sync bot", "remove state.new", "remove state.old", "sync bot"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v2");

    // A crash between the two renames: state.new is promoted and synced before state.old goes.
    rmSync(state, { recursive: true });
    botTree(old(), "v2");
    botTree(fresh(), "v3");
    const absent = record();
    recoverSnapshot(state, absent.steps);
    expect(absent.ops).toEqual(["rename state.new state", "sync bot", "remove state.new", "remove state.old", "sync bot"]);
    expect(readFileSync(join(state, "note"), "utf8")).toBe("v3");
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  });
});
