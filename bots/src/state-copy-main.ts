// One state copy (state.ts) in its own process, so a large copy never blocks the supervisor and a restore can run
// in its own cgroup. Exits 0, or 1 after printing only the failure reason.
//   restore <snapshot dir> <tmpfs> <BOTS_STATE_MB>
//   save    <tmpfs> <snapshot dir> <BOTS_STATE_MB>

import { relative } from "node:path";
import { SANDBOX_SESSION_DIR, SANDBOX_STATE_DIR } from "./oci";
import { CopyError, copyTree, ensureDirectories, openSnapshot, saveSnapshot, stateLimits } from "./state";

const [command, from, to, stateMb] = process.argv.slice(2);
try {
  const mb = Number(stateMb);
  if (!from || !to || !Number.isSafeInteger(mb) || mb < 1) throw new CopyError("io");
  if (command === "restore") {
    openSnapshot(from);
    copyTree(from, to, stateLimits(mb), false);
    ensureDirectories(to, relative(SANDBOX_STATE_DIR, SANDBOX_SESSION_DIR).split("/"));
  } else if (command === "save") {
    saveSnapshot(from, to, stateLimits(mb));
  } else {
    throw new CopyError("io");
  }
} catch (error) {
  process.stdout.write(error instanceof CopyError ? error.reason : "io");
  process.exit(1);
}
