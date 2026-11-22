import { join } from "node:path";
import type { BotRole } from "./oci";
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
  /** A sibling's key, when the caller named the bot by owner and key. Main, and a bot found by its directory, have none. */
  botKey?: string;
  /** sha256 of the owner DID: Main's own id. The gateway totals an owner's bots under it. A bot found by its directory alone counts as its own owner. */
  ownerId: string;
  containerId: string;
  dataDir: string;
  /** The saved state on disk (a plain directory), copied into the tmpfs at stateMount while the bot runs. */
  stateSnapshot: string;
  lastUsedFile: string;
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

export function botLayout(botId: string, roots: LayoutRoots, owner: { botKey?: string; ownerId?: string } = {}): BotLayout {
  const egress = egressPaths(roots.egressRoot, botId);
  const dataDir = join(roots.dataRoot, botId);
  const bundleDir = join(roots.runRoot, botId);
  if (owner.ownerId !== undefined && !BOT_ID.test(owner.ownerId)) throw new Error("invalid owner id");
  return {
    botId,
    ...(owner.botKey ? { botKey: owner.botKey } : {}),
    ownerId: owner.ownerId ?? botId,
    // Short enough for runsc's own socket paths; 128 bits still never collide between owners.
    containerId: `bot-${botId.slice(0, 32)}`,
    dataDir,
    stateSnapshot: join(dataDir, "state"),
    lastUsedFile: join(dataDir, "last-used"),
    bundleDir,
    stateMount: join(bundleDir, "state"),
    ...egress,
  };
}

/** Main has no key; a sibling has the key the backend chose. */
export function botRole(layout: BotLayout): BotRole {
  return layout.botKey === undefined ? "main" : "sibling";
}
