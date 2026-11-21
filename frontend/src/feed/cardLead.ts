// The line a folded ship card shows under its title: what moved. Every other card shows its summary, or its title when it
// has none (HomeFeedEntries describe); the row never falls back to a question's why-now or to the body.
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";

export function cardLead(record: BoardRecord): string | undefined {
  if (record.kind === "ship") return `${record.status.charAt(0).toUpperCase()}${record.status.slice(1)} · ${record.component} ${record.prevVersion ? `${record.prevVersion} → ` : ""}${record.version}`;
  return undefined;
}
