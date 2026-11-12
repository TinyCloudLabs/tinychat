// A bot's working state on disk: its state snapshot, its last-use marker and its run directory. The supervisor deletes
// it once the bot has gone unused for BOTS_RETENTION_DAYS (see BotManager.sweepUnused).

import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { BOT_ID } from "./owner";
import type { SandboxLauncher } from "./bot";
import type { BotLayout } from "./layout";

/** Why a deletion kept the bot's working state: a fixed code, logged as `cause`. */
export type DeleteSkip = "archive_pending" | "closing" | "teardown_failed" | "unsafe_path" | "mounted" | "error";

/** Records that the bot served a request at `at`: a temporary file, fsynced, renamed over the marker. */
export function markUsed(layout: BotLayout, at = Date.now()): void {
  const fresh = `${layout.lastUsedFile}.new`;
  const file = openSync(fresh, "w", 0o600);
  try {
    writeSync(file, new Date(at).toISOString());
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(fresh, layout.lastUsedFile);
}

/** Uses snapshot mtime only when the marker is missing. An invalid marker refuses the sweep with an error. */
export function lastUsed(layout: BotLayout): number | undefined {
  const marker = lstatSync(layout.lastUsedFile, { throwIfNoEntry: false });
  if (marker) {
    if (!marker.isFile()) throw new Error("invalid last-used marker");
    const at = Date.parse(readFileSync(layout.lastUsedFile, "utf8"));
    if (!Number.isFinite(at)) throw new Error("invalid last-used marker");
    return at;
  }
  return statSync(layout.stateSnapshot, { throwIfNoEntry: false })?.mtimeMs;
}

/**
 * Removes the bot's data directory (state snapshot and marker) and its run directory once its sandbox has stopped.
 * Removes nothing unless each one that exists is a directory (not a symlink) resolving to `<resolved root>/<bot id>`,
 * and nothing is mounted at or under either. Returns the check that refused.
 */
export async function removeWorkingState(
  layout: BotLayout,
  host: Pick<SandboxLauncher, "mountPoints">,
): Promise<DeleteSkip | undefined> {
  if (!BOT_ID.test(layout.botId)) return "unsafe_path";
  const dirs: string[] = [];
  for (const dir of [layout.dataDir, layout.bundleDir]) {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory()) return "unsafe_path";
    const root = realpathSync(dirname(dir));
    const real = realpathSync(dir);
    if (real !== join(root, layout.botId) || !real.startsWith(`${root}${sep}`)) return "unsafe_path";
    dirs.push(real);
  }
  if (host.mountPoints!().some(point => dirs.some(dir => point === dir || point.startsWith(`${dir}${sep}`)))) return "mounted";
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  return undefined;
}

export function rootProblem(path: string, uid: number): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isDirectory()) return "not_directory";
  if (stat.uid !== uid) return "wrong_owner";
  if (stat.mode & 0o022) return "group_or_world_writable";
}
