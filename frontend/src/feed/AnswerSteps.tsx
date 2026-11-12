import { CheckIcon, XIcon } from "lucide-react";
import type { FeedResponseHandling } from "@tinycloud/sdk-services/feed";
import type { HomeFeedEntry } from "./feedStoreTypes";

/** The agent's receipt and outcome for one response: a typed card's own record of it, else the card's latest. */
export function answerHandling(entry: HomeFeedEntry, responseId: string): FeedResponseHandling {
  const receipt = entry.responseHandling?.[responseId];
  return {
    acknowledgement: receipt?.acknowledgement ?? (entry.state.acknowledgement?.responseId === responseId ? entry.state.acknowledgement : null),
    outcome: receipt?.outcome ?? (entry.state.outcome?.responseId === responseId ? entry.state.outcome : null),
  };
}

/**
 * A saved answer's three steps, each ticked with its time as it arrives: Sent, Agent received (or "<agent> received
 * it"), then Completed or Failed. A message (`final` false) has no outcome step unless the agent reports one.
 */
export function AnswerSteps({ sent, acknowledgement, outcome, agent, final = true }: { sent: string; agent?: string; final?: boolean } & FeedResponseHandling) {
  const failed = outcome?.phase === "failed";
  const steps = [
    { key: "sent", label: "Sent", state: "done", at: sent },
    // An outcome comes from the agent, so it also shows the answer was received.
    { key: "received", label: agent ? `${agent} received it` : "Agent received", state: acknowledgement || outcome ? "done" : "upcoming", at: acknowledgement?.createdAt },
    { key: "outcome", label: failed ? "Failed" : "Completed", state: !outcome ? "upcoming" : failed ? "failed" : "done", at: outcome?.createdAt },
  ].filter((step) => final || step.key !== "outcome" || outcome);
  return <ol aria-label="Answer steps" className="space-y-1.5">
    {steps.map((step) => <li key={step.key} data-step={step.key} data-state={step.state} className="flex items-center gap-2 data-[state=upcoming]:text-muted-foreground">
      {step.state === "upcoming"
        ? <span aria-hidden className="size-4 shrink-0 rounded-full border-[1.5px] border-muted-foreground" />
        : <span className={`flex size-4 shrink-0 items-center justify-center rounded-full motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-500 ${step.state === "failed" ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>{step.state === "failed" ? <XIcon aria-hidden className="size-3" strokeWidth={3} /> : <CheckIcon aria-hidden className="size-3" strokeWidth={3} />}</span>}
      <span className={step.state === "failed" ? "font-medium text-destructive" : step.state === "done" ? "font-medium" : ""}>{step.label}{step.state === "upcoming" && <span className="sr-only">, not yet</span>}</span>
      {step.at && <time dateTime={step.at} className="ml-auto text-xs text-muted-foreground">{new Date(step.at).toLocaleString()}</time>}
    </li>)}
  </ol>;
}
