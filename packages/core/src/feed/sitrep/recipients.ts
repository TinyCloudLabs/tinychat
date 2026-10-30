import type { BoardRecord } from "./schema";

/** A hold's owner, else the card's owner, else its poster. Split co-owners; never route to Sam. */
export function recipients(record: BoardRecord): string[] {
  const named = record.kind === "hold" ? record.owner : ("owner" in record && record.owner ? record.owner : record.from);
  return [...new Set(named.split("/").map((name) => name.trim()).filter((name) => name && name.toLowerCase() !== "sam"))];
}
