// The separate action for earlier (v1) chat history (TC-4225): shown only while a read held earlier messages back.
// It is the only thing that asks for the network-wide decrypt; the chat itself never waits on it.
import { Button } from "@/components/ui/button";
import { EARLIER_HISTORY_STRINGS } from "./botsStrings";
import type { EarlierHistory } from "./earlierHistory";

export function EarlierHistoryAction({ earlier }: { earlier: EarlierHistory }) {
  const { status, onMove } = earlier;
  const note = status === "declined" ? EARLIER_HISTORY_STRINGS.declined
    : status === "failed" ? EARLIER_HISTORY_STRINGS.failed
    : EARLIER_HISTORY_STRINGS.held;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-callout text-muted-foreground" data-earlier-history="">
      <p>{note}</p>
      <Button type="button" variant="outline" size="sm" disabled={status === "moving"} onClick={onMove}>
        {status === "moving" ? EARLIER_HISTORY_STRINGS.moving : EARLIER_HISTORY_STRINGS.move}
      </Button>
    </div>
  );
}
