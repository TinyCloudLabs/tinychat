// A saved answer's steps (from Hunter's bridge-feed design): Sent, then "<agent> received it", then Done or Failed,
// each ticked with its time as the agent's receipts arrive, in the feed's own time words. They sit under the
// answer's own sentence.
import { CheckIcon, XIcon } from "lucide-react";
import type { FeedResponseHandling } from "@tinycloud/sdk-services/feed";
import { cardTime } from "./cardKit";

export function AnswerSteps({ sent, acknowledgement, outcome, agent, now }: { sent: string; agent: string; now: number } & FeedResponseHandling) {
  const failed = outcome?.phase === "failed";
  const steps = [
    { key: "sent", label: "Sent", state: "done", at: sent },
    // An outcome comes from the agent, so it also shows the answer was received.
    { key: "received", label: `${agent} received it`, state: acknowledgement || outcome ? "done" : "upcoming", at: acknowledgement?.createdAt },
    { key: "outcome", label: failed ? "Failed" : "Done", state: !outcome ? "upcoming" : failed ? "failed" : "done", at: outcome?.createdAt },
  ];
  return <ol aria-label="Answer steps" className="mt-1.5 space-y-1 text-[13px] leading-[18px]">
    {steps.map((step) => <li key={step.key} data-step={step.key} data-state={step.state} className="flex min-h-5 items-center gap-2 data-[state=upcoming]:text-muted-foreground">
      {step.state === "upcoming"
        ? <span aria-hidden className="size-4 shrink-0 rounded-full border-[1.5px] border-muted-foreground" />
        : <span aria-hidden className={`grid size-4 shrink-0 place-items-center rounded-full motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-500 ${step.state === "failed" ? "bg-destructive text-destructive-foreground" : "bg-foreground text-background"}`}>{step.state === "failed" ? <XIcon className="size-3" strokeWidth={3} /> : <CheckIcon className="size-3" strokeWidth={3} />}</span>}
      <span className={`min-w-0 break-words ${step.state === "failed" ? "font-medium text-destructive" : step.state === "done" ? "font-medium" : ""}`}>{step.label}{step.state === "upcoming" && <span className="sr-only">, not yet</span>}</span>
      {step.at && <time dateTime={step.at} className="ml-auto shrink-0 tabular-nums text-muted-foreground">{cardTime(step.at, now)}</time>}
    </li>)}
  </ol>;
}
