// Account erase for the Courier stores when the Courier runtime is not running in this gateway (BOTS_COURIER_ENABLED
// off): the files an earlier run may have left, removed directly. With the runtime running, CourierGateway.erase does
// the same and also clears what its intake holds in memory. Nothing here reaches the owner's space.
import { closeSync, existsSync, fsyncSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sealKeyFromDstack } from "../dstack-key";
import { botIdFor, OWNER_DID } from "../owner";
import { erasePeerFiles } from "./peer-store";

function removeSealed(dir: string, id: string): void {
  if (!existsSync(dir)) return;
  rmSync(join(dir, `${id}.json`), { force: true });
  rmSync(join(dir, `${id}.json.new`), { force: true });
  const handle = openSync(dir, "r");
  try { fsyncSync(handle); } finally { closeSync(handle); }
}

/**
 * Removes the owner's Courier grant, peer state (rows and SDK records) and intake state from the stores under `root`.
 * The seal key is asked for only when SDK records exist, since those are attributed to an owner by opening them.
 */
export async function eraseCourierFiles(root: string, owner: string, sealKey: () => Promise<Uint8Array> = sealKeyFromDstack): Promise<void> {
  const lower = owner.toLowerCase();
  if (!OWNER_DID.test(lower)) throw new Error("invalid Courier owner");
  const id = botIdFor(lower);
  removeSealed(join(root, "courier-grants"), id);
  removeSealed(join(root, "courier-intake"), id);
  const peers = join(root, "courier-peers");
  if (!existsSync(peers)) return;
  erasePeerFiles(peers, lower, existsSync(join(peers, "sdk")) ? await sealKey() : new Uint8Array(32));
}
