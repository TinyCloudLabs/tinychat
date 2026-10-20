// TC-1152 S2c-1: the Combine sheet, the user-visible part of "combine two partial transcripts".
// One sheet (a bottom sheet on a phone, a dialog beside it) walking useCombineFlow's steps:
// pick the other capture -> "Checking..." -> the evidence and ONE explicit Combine tap.
// A pair the check refused offers only a secondary "Combine anyway". Nothing is combined by
// opening, picking or waiting.
import type { ReactNode } from "react";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatSpokenDuration, rowWhen } from "../formatters";
import { librarySourceLabel } from "../libraryKinds";
import type { LibraryItem } from "../LibraryRow";
import { COMBINE_MAX_SEGMENTS_PER_MEMBER } from "./bodySegments";
import { combineCandidates } from "./candidates";
import { captureLabel } from "./evidence";
import type { CombineFlow, CombineState } from "./useCombineFlow";

const TITLES: Record<Exclude<CombineState["step"], "idle">, string> = {
  pick: "Combine with another capture",
  analyzing: "Checking these captures",
  confirm: "Combine these captures?",
  writing: "Combining",
  tooLarge: "Too large to combine here",
  error: "Couldn’t combine",
};

function CaptureLine(props: { item: LibraryItem; now: Date }) {
  const meta = [librarySourceLabel(props.item.source), rowWhen(props.item.startedAt, props.now, false), props.item.durationSecs !== null ? formatSpokenDuration(props.item.durationSecs) : null]
    .filter((part): part is string => !!part).join(" · ");
  return (
    <>
      <span className="block text-callout [overflow-wrap:anywhere]">{props.item.title ?? "Untitled"}</span>
      <span className="tnum block text-meta text-muted-foreground">{meta}</span>
    </>
  );
}

function Pair(props: { source: LibraryItem; other: LibraryItem; now: Date }) {
  return (
    <ul className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="combine-pair" aria-label="The two captures">
      <li><CaptureLine item={props.source} now={props.now} /></li>
      <li><CaptureLine item={props.other} now={props.now} /></li>
    </ul>
  );
}

export function CombineSheet(props: { flow: CombineFlow; items: readonly LibraryItem[]; now: Date }) {
  const { flow, now } = props;
  const state = flow.state;
  if (state.step === "idle") return null;
  const busy = state.step === "writing" && state.stage === "saving";
  const cancelLabel = state.step === "confirm" ? "Don’t combine" : "Cancel";
  let body: ReactNode;
  let footer: ReactNode;

  if (state.step === "pick") {
    const candidates = combineCandidates(state.source, props.items);
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-callout text-muted-foreground">Pick the other capture of this meeting. Nothing is combined until you confirm on the next screen.</p>
        {candidates.length === 0 ? (
          <p role="status" className="text-callout" data-testid="combine-no-candidates">No other capture overlaps this meeting’s time, so there is nothing to combine it with.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Captures that overlap this meeting">
            {candidates.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => flow.pick(item)} data-testid="combine-candidate" data-item-id={item.id}
                  className="tap-transparent min-h-11 w-full rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2">
                  <CaptureLine item={item} now={now} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
    footer = <Button type="button" variant="outline" onClick={flow.cancel}>Cancel</Button>;
  } else if (state.step === "analyzing") {
    body = (
      <div className="flex flex-col gap-4" data-testid="combine-analyzing">
        <Pair source={state.source} other={state.other} now={now} />
        <div role="status" className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-callout"><Loader2Icon aria-hidden className="size-4 motion-safe:animate-spin" /> Checking whether these are the same meeting…</p>
          <p className="text-meta text-muted-foreground">This can take a few seconds on a long meeting. Nothing is saved yet.</p>
          <Skeleton lines={3} />
        </div>
      </div>
    );
    footer = <Button type="button" variant="outline" onClick={flow.cancel}>Cancel</Button>;
  } else if (state.step === "confirm") {
    const { evidence } = state;
    body = (
      <div className="flex flex-col gap-4" data-testid="combine-confirm" data-passed={evidence.passed ? "true" : "false"}>
        <Pair source={state.source} other={state.other} now={now} />
        <section aria-labelledby="combine-verdict" className="flex flex-col gap-2">
          <h3 id="combine-verdict" className={cn("text-headline", !evidence.passed && "text-amber-700 dark:text-amber-300")} data-testid="combine-verdict">{evidence.headline}</h3>
          {evidence.reason && <p className="text-callout text-muted-foreground" data-testid="combine-reason">{evidence.reason}</p>}
          <dl className="flex flex-col gap-2" data-testid="combine-evidence">
            {evidence.lines.map((line) => (
              <div key={line.id} className="flex flex-col" data-evidence={line.id} data-met={line.met === undefined ? undefined : line.met ? "true" : "false"}>
                <dt className="text-meta text-muted-foreground">{line.label}{line.met === undefined ? "" : line.met ? " · met" : " · not met"}</dt>
                <dd className="text-callout [overflow-wrap:anywhere]">{line.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        {evidence.passed
          ? <p className="text-meta text-muted-foreground">This adds one combined meeting to your Library. Your two original captures aren’t changed, and you can delete the combined meeting later.</p>
          : <p className="text-meta text-muted-foreground">“Combine anyway” lays the two transcripts end to end at their recorded times, with a marked seam, and saves that the check did not match. Your original captures aren’t changed.</p>}
      </div>
    );
    footer = evidence.passed ? (
      <>
        <Button type="button" variant="outline" onClick={flow.cancel}>{cancelLabel}</Button>
        <Button type="button" onClick={() => flow.confirm(false)} data-testid="combine-confirm-button">Combine</Button>
      </>
    ) : (
      <>
        <Button type="button" variant="outline" onClick={() => flow.confirm(true)} data-testid="combine-anyway-button">Combine anyway</Button>
        <Button type="button" onClick={flow.cancel}>{cancelLabel}</Button>
      </>
    );
  } else if (state.step === "writing") {
    body = (
      <div className="flex flex-col gap-4" data-testid="combine-writing">
        <Pair source={state.source} other={state.other} now={now} />
        <p role="status" className="flex items-center gap-2 text-callout"><Loader2Icon aria-hidden className="size-4 motion-safe:animate-spin" /> {state.stage === "saving" ? "Saving the combined meeting…" : "Preparing the combined transcript…"}</p>
      </div>
    );
    footer = busy ? null : <Button type="button" variant="outline" onClick={flow.cancel}>Cancel</Button>;
  } else if (state.step === "tooLarge") {
    body = (
      <div className="flex flex-col gap-3" data-testid="combine-too-large">
        <Pair source={state.source} other={state.other} now={now} />
        <p role="alert" className="text-callout">This recording is too long to combine here: one transcript has {state.segments.toLocaleString()} segments, and the limit is {COMBINE_MAX_SEGMENTS_PER_MEMBER.toLocaleString()} each. Nothing was changed.</p>
      </div>
    );
    footer = <Button type="button" onClick={flow.cancel}>Close</Button>;
  } else {
    body = (
      <div className="flex flex-col gap-3" data-testid="combine-error">
        <Pair source={state.source} other={state.other} now={now} />
        <p role="alert" className="text-callout">{state.message}</p>
      </div>
    );
    footer = (
      <>
        <Button type="button" variant="outline" onClick={flow.cancel}>Close</Button>
        {state.retry !== null && <Button type="button" onClick={flow.retry} data-testid="combine-retry">Try again</Button>}
      </>
    );
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(next) => { if (!next) flow.cancel(); }}
      dismissible={!busy}
      title={TITLES[state.step]}
      description={state.step === "pick" ? undefined : captureLabel(state.source)}
      contentProps={{ "data-testid": "combine-sheet", "data-step": state.step }}
      footer={footer}
    >
      <ResponsiveSheetBody>{body}</ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
