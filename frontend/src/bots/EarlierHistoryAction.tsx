// The separate action for earlier (v1) chat history (TC-4225): shown only while a read held earlier messages back.
// It is the only thing that asks for the network-wide decrypt; the chat itself never waits on it.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EARLIER_HISTORY_STRINGS } from "./earlierHistoryStrings";
import { isEarlierHistoryHeld, type EarlierHistoryMove } from "./earlierHistory";

type Status = "idle" | "moving" | "declined" | "failed";

export function EarlierHistoryAction({ move }: { move: EarlierHistoryMove }) {
  const { bot, request, reload } = move;
  const [status, setStatus] = useState<Status>("idle");
  const onMove = () => {
    setStatus("moving");
    void (async () => {
      try {
        if (!(await request())) { setStatus("declined"); return; }
        await reload();
        // A chat's read that fails does not reject (the chat shows its own failure row), so what the move achieved is
        // read from the state: if the read held records back again, or never ran, the move did not happen.
        setStatus(isEarlierHistoryHeld(bot) ? "failed" : "idle");
      } catch {
        setStatus("failed");
      }
    })();
  };
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
