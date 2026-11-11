// A bot's working state on disk: its state image, its last-use marker and its run directory. The supervisor deletes
// it once the bot has gone unused for BOTS_RETENTION_DAYS (see BotManager.sweepUnused).

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import type { BotLayout } from "./layout";

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

/** Removes the bot's data directory (state image and marker) and its run directory. Its sandbox must be stopped. */
export function removeWorkingState(layout: BotLayout): void {
  rmSync(layout.dataDir, { recursive: true, force: true });
  rmSync(layout.bundleDir, { recursive: true, force: true });
}
