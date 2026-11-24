// An owner's Courier model calls run as their own gateway bot, apart from Main: own request slot, own token budget.
// A peer can use up Courier's allowances, never the owner's chat. Details: TC-4058
import { createHash } from "node:crypto";
import { botIdFor } from "../owner";

const COURIER_KEY = createHash("sha256").update("tinychat-bots courier v1").digest("hex").slice(0, 32);

export const courierBotId = (owner: string): string => botIdFor(owner, COURIER_KEY);
