import * as Dialog from "@radix-ui/react-dialog";
import { ActivityIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppPlatform } from "@/lib/platform";
import { logPipeline } from "@/lib/debugLog";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { activityForNote, type ActivityJob } from "./activitySelector";

export interface ActivityNote { item: LibraryItem; jobs: ActivityJob[] }

export function activityNotes(items: readonly LibraryItem[], views: ReadonlyMap<string, NotePipelineView>, platform: AppPlatform): ActivityNote[] {
  return items.map((item) => ({ item, jobs: activityForNote(views.get(item.sourceId), platform) })).filter((note) => note.jobs.length > 0);
}

export function ActivityPanel(props: { items: readonly LibraryItem[]; views: ReadonlyMap<string, NotePipelineView>; platform: AppPlatform; onOpenNote: (id: string) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const notes = useMemo(() => activityNotes(props.items, props.views, props.platform), [props.items, props.views, props.platform]);
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    const next = new Map<string, string>();
    for (const note of notes) for (const job of note.jobs) {
      const key = `${note.item.sourceId}:${job.kind}`;
      next.set(key, job.state);
      if (previous.current.get(key) !== job.state) logPipeline("activity_job", note.item.sourceId, job.state, { destination: job.destination, engine: job.kind });
    }
    previous.current = next;
  }, [notes]);
  const running = notes.flatMap((note) => note.jobs).filter((job) => job.state === "running").length;
  const waiting = notes.flatMap((note) => note.jobs).filter((job) => job.state === "waiting").length;
  const attention = notes.flatMap((note) => note.jobs).filter((job) => job.state === "needs-attention").length;
  const content = (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="fixed right-4 top-[max(0.5rem,env(safe-area-inset-top))] z-30 flex min-h-11 items-center gap-1.5 rounded-full bg-background px-3 text-callout text-foreground shadow-sm ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Activity: ${running} running, ${waiting} waiting, ${attention} need attention`} data-testid="activity-button">
          <ActivityIcon aria-hidden="true" className="size-4" /> Activity
          {running > 0 && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" data-testid="activity-indicator" />}
          {attention > 0 && <span aria-hidden="true" className="text-destructive">!</span>}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[27.5rem] flex-col bg-background shadow-xl focus:outline-none" data-testid="activity-panel">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <div><Dialog.Title className="text-headline">Activity</Dialog.Title><Dialog.Description className="text-callout text-muted-foreground">{running} running · {waiting} waiting{attention > 0 ? ` · ${attention} need attention` : ""}</Dialog.Description></div>
            <Dialog.Close className="flex size-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close Activity"><XIcon aria-hidden="true" className="size-5" /></Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {notes.length === 0 ? <p className="py-8 text-callout text-muted-foreground">Nothing in progress. Everything is saved.</p> : notes.map(({ item, jobs }) => (
              <section key={item.sourceId} className="border-b border-border py-4 first:pt-1" aria-label={item.snippet ?? item.title ?? "Voice note"}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{item.snippet ?? item.title ?? "Voice note"}</h3><button type="button" className="min-h-11 text-callout text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setOpen(false); props.onOpenNote(item.id); }}>Open note</button></div>
                <ul className="space-y-3">{jobs.map((job) => <li key={job.kind} className="text-callout" data-state={job.state} data-track={job.kind}>
                  <div className="flex flex-wrap items-center justify-between gap-x-2"><span className="font-medium">{job.label} · {job.destination}</span><span className={job.state === "needs-attention" ? "text-destructive" : "text-muted-foreground"}>{job.state === "needs-attention" ? "Needs attention" : job.state === "running" ? "In progress" : "Waiting"}</span></div>
                  <p className="mt-1 text-muted-foreground">{job.detail}</p>
                  {job.progress !== undefined && <progress className="mt-2 h-1 w-full accent-primary" max={1} value={job.progress} aria-label={`${job.label} progress`} />}
                  {(job.retry || job.diagnostics) && <div className="mt-1 flex flex-wrap gap-3">{job.retry && <button type="button" className="min-h-11 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={job.retry}>Retry</button>}{job.diagnostics && <button type="button" className="min-h-11 text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { void navigator.clipboard?.writeText(`${item.sourceId} · ${job.kind} · ${job.diagnostics}`); }}>Copy details</button>}</div>}
                </li>)}</ul>
              </section>
            ))}
          </div>
          {(props.platform === "ios" || props.platform === "android") && <p className="border-t border-border px-4 py-3 text-callout text-muted-foreground">Uploads continue while Exo is open.</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
