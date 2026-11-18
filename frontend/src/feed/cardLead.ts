// The one line a folded card shows under its title (design mock, 11-17): for a question, why it is being asked now;
// for an update, what moved. A card whose record has neither gives none, and the row falls back to the card's body.
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";

export function cardLead(record: BoardRecord): string | undefined {
  if (record.kind === "ask") return record.context.whyNow || undefined;
  if (record.kind === "ship") return `${record.status.charAt(0).toUpperCase()}${record.status.slice(1)} · ${record.component} ${record.prevVersion ? `${record.prevVersion} → ` : ""}${record.version}`;
  return undefined;
}
