// TC-3325: carries out the deletion of a bot that its owner's record already holds as being deleted.
import { BOT_KEY, type BotsRegistry } from "./bots-registry.js";

/** What carrying out a deletion needs from the rest of the backend. Each is safe to repeat. */
export interface DeletionPorts {
  registry: Pick<BotsRegistry, "read" | "closeGrant" | "clearRevoke" | "finishDelete">;
  /** Asks the bots service to remove the bot's working state. `seq` is the counter of the owner's record. */
  removeFromService(address: string, key: string, seq: number): Promise<"gone" | "waiting" | "failed">;
  /** The delegation id of the bot's stored history permission, or undefined when none is stored. */
  storedGrantCid(address: string, key: string): Promise<string | undefined>;
  /** Removes the bot's stored history permission. Removing one that is not there succeeds. */
  forgetGrant(address: string, key: string): Promise<void>;
  /** Revokes a delegation at the node. */
  revoke(cid: string): Promise<void>;
}

/** `deleted`: the bot is in the deleted list. `waiting` and `failed`: try again later. `not_deleting`: nothing to do. */
export type DeletionOutcome = "deleted" | "waiting" | "failed" | "not_deleting";

/**
 * Best effort, and expected to be refused: a node accepts a revocation from the owner, not from the backend, which
 * only holds the grant. If it does succeed nothing is owed any more; otherwise the id stays in the record.
 */
async function revokeAndClear(ports: DeletionPorts, address: string, key: string, cid: string): Promise<void> {
  try {
    await ports.revoke(cid);
  } catch {
    return;
  }
  await ports.registry.clearRevoke(address, key);
}

/**
 * One run over one bot. It can stop after any step and be run again: every step is decided from the owner's record.
 *
 * The order matters. The record says "no further permission for this bot", with the delegation id, BEFORE the stored
 * permission is removed. So a run that stops in between still knows what to revoke, and a permission stored by a
 * renewal that raced with the deletion is recognised as one that must not stay.
 */
export async function carryOutDeletion(ports: DeletionPorts, address: string, key: string): Promise<DeletionOutcome> {
  if (!BOT_KEY.test(key)) return "not_deleting";
  const row = await ports.registry.read(address);

  const gone = row.deleted.find(entry => entry.key === key);
  if (gone) {
    // Already deleted. A stored permission that came back is removed, and a revocation still owed is tried again.
    try {
      await ports.forgetGrant(address, key);
    } catch {
      return "failed";
    }
    if (gone.revoke) await revokeAndClear(ports, address, key, gone.revoke.cid);
    return "deleted";
  }

  let bot = row.bots.find(entry => entry.key === key);
  if (!bot || bot.state !== "deleting") return "not_deleting";

  if (!bot.grantClosed) {
    const outcome = await ports.removeFromService(address, key, row.seq);
    if (outcome !== "gone") return outcome;
    let cid: string | undefined;
    try {
      cid = await ports.storedGrantCid(address, key);
    } catch {
      // Without reading it, the delegation to revoke is not known. Nothing is closed or removed; a later run tries again.
      return "failed";
    }
    bot = await ports.registry.closeGrant(address, key, cid);
    if (!bot) return "failed";
  }

  try {
    await ports.forgetGrant(address, key);
  } catch {
    return "failed";
  }
  if (bot.revoke) await revokeAndClear(ports, address, key, bot.revoke.cid);
  return (await ports.registry.finishDelete(address, key)) ? "deleted" : "failed";
}

/** What a pass found. `listed` is false when the owners could not be listed: the pass then did nothing. */
export interface SweepResult { listed: boolean; ran: number; skipped: number }

/** How often the pass over every owner runs. A deletion is also run at once when it is recorded; the pass is what picks up the rest. */
export const BOT_DELETION_PASS_MS = 5 * 60_000;

/** Runs deletions: one bot's when it is recorded as being deleted, and every outstanding one on each pass. */
export class BotDeletions {
  readonly #ports: DeletionPorts & { registry: DeletionPorts["registry"] & Pick<BotsRegistry, "owners"> };
  readonly #running = new Set<string>();

  constructor(ports: DeletionPorts & { registry: DeletionPorts["registry"] & Pick<BotsRegistry, "owners"> }) {
    this.#ports = ports;
  }

  /** Carries out one bot's deletion, unless a run for that bot is already under way. Never throws: a failure is an outcome. */
  async run(address: string, key: string): Promise<DeletionOutcome | "busy"> {
    const id = `${address.toLowerCase()}/${key}`;
    if (this.#running.has(id)) return "busy";
    this.#running.add(id);
    try {
      return await carryOutDeletion(this.#ports, address, key);
    } catch {
      return "failed";
    } finally {
      this.#running.delete(id);
    }
  }

  /**
   * One pass over every owner: each bot that is being deleted. A revocation still owed for a bot that is already
   * deleted is not tried again: a node refuses one from the backend, which only holds the grant. Its id stays in the
   * record.
   */
  async sweep(): Promise<SweepResult> {
    let owners: string[];
    try {
      owners = await this.#ports.registry.owners();
    } catch {
      return { listed: false, ran: 0, skipped: 0 };
    }
    let ran = 0;
    let skipped = 0;
    for (const address of owners) {
      let keys: string[];
      try {
        const row = await this.#ports.registry.read(address);
        keys = row.bots.filter(bot => bot.state === "deleting").map(bot => bot.key);
      } catch {
        // One owner's unreadable record does not hold up the others. It is tried again on the next pass.
        skipped += 1;
        continue;
      }
      for (const key of keys) {
        await this.run(address, key);
        ran += 1;
      }
    }
    return { listed: true, ran, skipped };
  }
}
