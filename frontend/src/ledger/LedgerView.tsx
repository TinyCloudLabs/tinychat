import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LedgerRow } from "./model";

export interface LedgerViewProps {
  rows: readonly LedgerRow[];
  now: number;
  state: "loading" | "ready" | "failed";
  onRefresh(): void;
}

export function LedgerView({ rows, now, state, onRefresh }: LedgerViewProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-scroll-root>
      <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-7 sm:px-8 sm:pb-12">
        <div className="mb-8 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-title-1 text-foreground">What your agents are doing</h2>
            <p className="mt-2 text-body text-muted-foreground">{rows.length ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"}` : "Ledger"}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Refresh ledger" disabled={state === "loading"} onClick={onRefresh}>
            <RefreshCwIcon aria-hidden className="size-4" />
          </Button>
        </div>
        {state === "loading" ? <p role="status" className="py-8 text-body text-muted-foreground">Loading tasks…</p> : null}
        {state === "failed" ? <p role="alert" className="py-8 text-body text-muted-foreground">Couldn't load your tasks. Try refreshing.</p> : null}
        {state === "ready" && !rows.length ? <p className="max-w-md py-8 text-body leading-relaxed text-muted-foreground">No tasks to show. When an agent you've connected records a task, it shows here.</p> : null}
        {rows.length > 0 ? (
          <>
            <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_13rem] gap-6 border-b border-border pb-3 text-label text-muted-foreground md:grid">
              <span>Task / agent</span><span>Stage / time in stage</span>
            </div>
            <ul aria-label="Agent tasks" className="divide-y divide-border border-b border-border">
              {rows.map((row) => {
                const minutes = Math.max(0, Math.floor((now - Date.parse(row.stageSince)) / 60_000));
                const elapsed = minutes < 1 ? "Under 1m" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
                const tasks = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;
                const dependencies = [row.blockedBy ? `Blocked by ${tasks(row.blockedBy)}` : "", row.blocks ? `Blocks ${tasks(row.blocks)}` : ""].filter(Boolean).join(" · ");
                return (
                  <li key={row.id} className="grid gap-3 py-5 [overflow-wrap:anywhere] md:grid-cols-[minmax(0,1fr)_13rem] md:gap-6">
                    <div className="min-w-0">
                      <h3 className="text-headline text-foreground">{row.title}</h3>
                      <p className="mt-1.5 text-label text-muted-foreground">{row.agentLabel}</p>
                      {row.condition ? <p className="mt-3 text-body text-foreground">{row.condition}</p> : null}
                      {row.note ? <p className="mt-2 whitespace-pre-wrap text-label leading-relaxed text-muted-foreground">{row.note}</p> : null}
                      {row.evidence && row.checkedBy ? <p className="mt-2 text-label text-muted-foreground">Checked by {row.checkedBy}: {row.evidence}</p> : null}
                      {dependencies ? <p className="mt-2 text-label text-muted-foreground">{dependencies}</p> : null}
                    </div>
                    <div className="flex items-baseline gap-2 md:flex-col md:gap-1.5">
                      <span className="rounded-md bg-surface-2 px-2 py-1 text-label font-medium text-foreground">{row.stage}</span>
                      <time dateTime={row.stageSince} title={row.stageSince} className="shrink-0 text-label tabular-nums text-muted-foreground">{elapsed} in stage</time>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
