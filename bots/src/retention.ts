// A bot's working state on disk: its state image, its last-use marker and its run directory. The supervisor deletes
// it once the bot has gone unused for BOTS_RETENTION_DAYS (see BotManager.sweepUnused).

import {
  closeSync,
  existsSync,
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
import type { SandboxLauncher } from "./bot";
import type { BotLayout } from "./layout";

/** Why a deletion kept the bot's working state: a fixed code, logged as `cause`. */
export type DeleteSkip = "teardown_failed" | "unsafe_path" | "mounted" | "loop_attached" | "error";

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

/** When the bot was last used: its marker, else its state image's mtime; undefined for a bot with neither. */
export function lastUsed(layout: BotLayout): number | undefined {
  if (existsSync(layout.lastUsedFile)) {
    const at = Date.parse(readFileSync(layout.lastUsedFile, "utf8"));
    if (Number.isFinite(at)) return at;
  }
  return statSync(layout.stateImage, { throwIfNoEntry: false })?.mtimeMs;
}

/**
 * Removes the bot's data directory (state image and marker) and its run directory once its sandbox has stopped.
 * Removes nothing unless each one that exists is a directory (not a symlink) resolving to `<resolved root>/<bot id>`,
 * nothing is mounted at or under either, and no loop device backs the state image; returns the check that refused.
 */
export async function removeWorkingState(
  layout: BotLayout,
  host: Pick<SandboxLauncher, "mountPoints" | "loopAttached">,
): Promise<DeleteSkip | undefined> {
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
  if (host.mountPoints().some(point => dirs.some(dir => point === dir || point.startsWith(`${dir}${sep}`)))) return "mounted";
  if (await host.loopAttached(layout)) return "loop_attached";
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  return undefined;
}
