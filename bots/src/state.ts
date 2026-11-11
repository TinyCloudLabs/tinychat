// A bot's saved state. While a bot runs, its state lives in its own tmpfs; the supervisor copies it to disk
// (/data/bots/<bot id>/state) when a turn settles and when the bot stops, and into a fresh tmpfs when it starts.
// Everything in it was written by the bot, so both copies treat it as hostile:
// - every lookup goes through an open directory (/proc/self/fd/<fd>/<name>, the same as openat), and no symlink is
//   followed, at any level;
// - only directories, regular files and symlinks are copied, each created fresh by the supervisor: directories
//   0700, files with their permission bits only (no setuid, setgid or sticky bit) and their times, symlinks with
//   their target as text; no owner and no xattrs are copied. A device, FIFO or socket stops the copy;
// - every directory and file the copy creates is checked to sit at its own path under the destination;
// - the copy stops past the byte and entry caps.
// A copy that stops leaves the previous snapshot in place.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const COPY_FAILURES = ["special_file", "too_large", "too_many_files", "too_deep", "io"] as const;
export type CopyFailure = (typeof COPY_FAILURES)[number];

export class CopyError extends Error {
  readonly reason: CopyFailure;

  constructor(reason: CopyFailure) {
    super(reason);
    this.reason = reason;
  }
}

export interface CopyLimits {
  /** File bytes, each file counted in whole 4 KiB pages as tmpfs stores it, plus symlink targets. */
  maxBytes: number;
  /** Directories, files and symlinks below the top directory. */
  maxEntries: number;
}

/** tmpfs inodes per MiB of state (one per 16 KiB): the mount's nr_inodes and, less its root, the copy's entry cap. */
export const STATE_INODES_PER_MB = 64;

export function stateLimits(stateMb: number): CopyLimits {
  return { maxBytes: stateMb * 1024 * 1024, maxEntries: stateMb * STATE_INODES_PER_MB - 1 };
}

const PAGE = 4096;
/** Directory levels below the top; each level holds two descriptors open while it is copied. */
const MAX_DEPTH = 64;
const CHUNK = 1024 * 1024;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const SOURCE_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NOCTTY;
const SLASH = Buffer.from("/");

/** A name inside an open directory: the kernel resolves the descriptor, never the path that led to it. */
function at(fd: number, name?: Buffer): Buffer {
  const dir = Buffer.from(`/proc/self/fd/${fd}`);
  return name ? Buffer.concat([dir, SLASH, name]) : dir;
}

const pages = (bytes: number) => Math.ceil(bytes / PAGE) * PAGE;

/**
 * Copies the tree under the directory `src` into the empty directory `dst` (see the top of this file). With
 * `durable`, every file and directory written is fsynced. Throws CopyError; `dst` may then hold a partial copy.
 */
export function copyTree(src: string, dst: string, limits: CopyLimits, durable: boolean): void {
  const held = new Set<number>();
  const hold = (fd: number) => {
    held.add(fd);
    return fd;
  };
  const release = (fd: number) => {
    held.delete(fd);
    closeSync(fd);
  };
  const buffer = Buffer.allocUnsafe(CHUNK);
  let bytes = 0;
  let entries = 0;

  /** What the copy creates must sit exactly at `path`: nothing may land anywhere else. */
  const placed = (fd: number, path: Buffer) => {
    if (!readlinkSync(at(fd), { encoding: "buffer" }).equals(path)) throw new CopyError("io");
  };

  const copyFile = (from: Buffer, to: Buffer, path: Buffer) => {
    const source = hold(openSync(from, SOURCE_FILE));
    const stat = fstatSync(source);
    if (!stat.isFile()) throw new CopyError("special_file");
    if (bytes + pages(stat.size) > limits.maxBytes) throw new CopyError("too_large");
    const target = hold(openSync(to, NEW_FILE, 0o600));
    placed(target, path);
    let copied = 0;
    for (let read = readSync(source, buffer, 0, CHUNK, null); read > 0; read = readSync(source, buffer, 0, CHUNK, null)) {
      copied += read;
      if (bytes + pages(copied) > limits.maxBytes) throw new CopyError("too_large");
      for (let written = 0; written < read; ) written += writeSync(target, buffer, written, read - written);
    }
    bytes += pages(copied);
    fchmodSync(target, stat.mode & 0o777);
    futimesSync(target, stat.atime, stat.mtime);
    if (durable) fsyncSync(target);
    release(target);
    release(source);
  };

  const copyDirectory = (source: number, target: number, path: Buffer, depth: number) => {
    for (const name of readdirSync(at(source), { encoding: "buffer" })) {
      if (++entries > limits.maxEntries) throw new CopyError("too_many_files");
      const from = at(source, name);
      const to = at(target, name);
      const entryPath = Buffer.concat([path, SLASH, name]);
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(from, { encoding: "buffer" });
        bytes += link.length;
        if (bytes > limits.maxBytes) throw new CopyError("too_large");
        symlinkSync(link, to);
      } else if (stat.isFile()) {
        copyFile(from, to, entryPath);
      } else if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) throw new CopyError("too_deep");
        mkdirSync(to, 0o700);
        const subSource = hold(openSync(from, DIRECTORY));
        const subTarget = hold(openSync(to, DIRECTORY));
        placed(subTarget, entryPath);
        copyDirectory(subSource, subTarget, entryPath, depth + 1);
        if (durable) fsyncSync(subTarget);
        release(subTarget);
        release(subSource);
      } else {
        throw new CopyError("special_file");
      }
    }
  };

  try {
    const source = hold(openSync(src, DIRECTORY));
    const target = hold(openSync(dst, DIRECTORY));
    if (readdirSync(at(target)).length > 0) throw new CopyError("io");
    copyDirectory(source, target, readlinkSync(at(target), { encoding: "buffer" }), 0);
    if (durable) fsyncSync(target);
  } catch (error) {
    throw error instanceof CopyError ? error : new CopyError("io");
  } finally {
    for (const fd of held) closeSync(fd);
  }
}

/**
 * Creates the nested directories `parts` (0700) under `root` where they are missing, without following symlinks.
 * Whatever the bot left at one of those names stays as it is, and the walk ends there.
 */
export function ensureDirectories(root: string, parts: string[]): void {
  let fd = openSync(root, DIRECTORY);
  try {
    for (const part of parts) {
      const name = Buffer.from(part);
      try {
        mkdirSync(at(fd, name), 0o700);
      } catch {
        // Already there, or cannot be made: the open below decides.
      }
      let next: number;
      try {
        next = openSync(at(fd, name), DIRECTORY);
      } catch {
        return;
      }
      closeSync(fd);
      fd = next;
    }
  } finally {
    closeSync(fd);
  }
}

const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function fsyncDirectory(path: string): void {
  const fd = openSync(path, DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Whether a bot has a snapshot, i.e. has run before (a swap a crash interrupted counts). */
export function hasSnapshot(state: string): boolean {
  return exists(state) || exists(`${state}.old`);
}

/**
 * Finishes or undoes a swap a crash interrupted. A swap renames state to state.old, then state.new to state, then
 * removes state.old; state.new only takes part once it is complete and synced, and `state` exists from a bot's first
 * start (`openSnapshot`). So with `state` present any leftover is stale; without it, state.new is complete if
 * state.old is there too, and otherwise state.old is the last good copy.
 */
export function recoverSnapshot(state: string): void {
  const fresh = `${state}.new`;
  const old = `${state}.old`;
  if (!exists(state) && exists(old)) renameSync(exists(fresh) ? fresh : old, state);
  rmSync(fresh, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  fsyncDirectory(dirname(state));
}

/** Gets `state` ready to restore from: recovers an interrupted swap, or creates the empty first snapshot. */
export function openSnapshot(state: string): void {
  recoverSnapshot(state);
  if (exists(state)) return;
  mkdirSync(state, { mode: 0o700 });
  fsyncDirectory(dirname(state));
}

/** Copies a bot's tmpfs into a fresh state.new, synced, then swaps it in. On any failure the previous one stays. */
export function saveSnapshot(mount: string, state: string, limits: CopyLimits): void {
  const fresh = `${state}.new`;
  const old = `${state}.old`;
  recoverSnapshot(state);
  mkdirSync(fresh, { mode: 0o700 });
  try {
    copyTree(mount, fresh, limits, true);
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  if (exists(state)) renameSync(state, old);
  renameSync(fresh, state);
  rmSync(old, { recursive: true, force: true });
  fsyncDirectory(dirname(state));
}
