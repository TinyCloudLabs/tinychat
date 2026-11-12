import { join } from "node:path";
import { BOT_ID } from "./owner";

export interface LayoutRoots {
  /** Persistent volume: one directory per bot holding its saved state. */
  dataRoot: string;
  /** Supervisor-local scratch: OCI bundle and the bot's state tmpfs. */
  runRoot: string;
  /** Volume shared with the gateway: one directory per bot holding only its egress socket. */
  egressRoot: string;
}

/** Every host path one bot touches. Built only from the hashed bot id, so an owner string never reaches a path. */
export interface BotLayout {
  botId: string;
  containerId: string;
  dataDir: string;
  /** The saved state on disk (a plain directory), copied into the tmpfs at stateMount while the bot runs. */
  stateSnapshot: string;
  bundleDir: string;
  stateMount: string;
  egressDir: string;
  socketPath: string;
}

/** Where the gateway listens for one bot and what the supervisor mounts into that bot. Both sides must agree. */
export function egressPaths(egressRoot: string, botId: string): { egressDir: string; socketPath: string } {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id");
  const egressDir = join(egressRoot, botId);
  return { egressDir, socketPath: join(egressDir, "egress.sock") };
}

export function botLayout(botId: string, roots: LayoutRoots): BotLayout {
  const egress = egressPaths(roots.egressRoot, botId);
  const dataDir = join(roots.dataRoot, botId);
  const bundleDir = join(roots.runRoot, botId);
  return {
    botId,
    // Short enough for runsc's own socket paths; 128 bits still never collide between owners.
    containerId: `bot-${botId.slice(0, 32)}`,
    dataDir,
    stateSnapshot: join(dataDir, "state"),
    bundleDir,
    stateMount: join(bundleDir, "state"),
    ...egress,
  };
}
