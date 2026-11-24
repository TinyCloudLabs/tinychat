import type { ReadArea } from "./areas.js";

export type StandingArea = "meetings" | "feed_chats";

/** Telegram has its own grant and consent; a standing read never covers it. */
export function isStandingArea(area: ReadArea): area is StandingArea {
  return area !== "telegram";
}

/** Canonical lowercase did:pkh:eip155:1 owner DID. */
export type OwnerDid = string;

/** The backend can sign with this holder without serializing or exporting its key. */
export interface StandingHolder {
  did: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface HolderDeriver {
  derive(owner: OwnerDid, approvalId: string, generation: number): Promise<StandingHolder>;
}
