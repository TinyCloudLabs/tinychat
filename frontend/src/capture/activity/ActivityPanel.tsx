import * as Dialog from "@radix-ui/react-dialog";
import { ActivityIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppPlatform } from "@/lib/platform";
import type { UploadState } from "@/lib/audioUpload";
import type { PausedUpload } from "@/capture/upload/pausedUpload";
import { logPipeline } from "@/lib/debugLog";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { activityForFileUpload, activityForNote, type ActivityJob, type ActivityState } from "./activitySelector";

export interface ActivityNote { item: LibraryItem; jobs: ActivityJob[]; openLabel?: string }

export function activityNotes(items: readonly LibraryItem[], views: ReadonlyMap<string, NotePipelineView>, platform: AppPlatform): ActivityNote[] {
  return items.map((item) => ({ item, jobs: activityForNote(views.get(item.sourceId), platform) })).filter((note) => note.jobs.length > 0);
}

function sameJobs(a: readonly ActivityJob[], b: readonly ActivityJob[]): boolean {
  return a.length === b.length && a.every((job, index) => {
    const next = b[index];
    return next && job.kind === next.kind && job.state === next.state && job.label === next.label &&
      job.destination === next.destination && job.detail === next.detail && job.progress === next.progress &&
      job.diagnostics === next.diagnostics && Boolean(job.retry) === Boolean(next.retry) && job.action?.label === next.action?.label;
  });
}

export const ActivityNoteSection = memo(function ActivityNoteSection(props: ActivityNote & { onOpenNote: (id: string) => void; onClose: () => void }) {
  const { item, jobs } = props;
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | null>(null);
  return <section className="border-b border-border py-4 first:pt-1" aria-label={item.snippet ?? item.title ?? "Voice note"} data-activity-note={item.sourceId}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{item.snippet ?? item.title ?? "Voice note"}</h3><button type="button" className="min-h-11 text-callout text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { props.onClose(); props.onOpenNote(item.id); }}>{props.openLabel ?? "Open note"}</button></div>
    <ul className="space-y-3">{jobs.map((job) => <li key={job.kind} className="text-callout" data-state={job.state} data-track={job.kind}>
      <div className="flex flex-wrap items-center justify-between gap-x-2"><span className="font-medium">{job.label} · {job.destination}</span><span className={job.state === "needs-attention" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}>{job.state === "needs-attention" ? "Needs attention" : job.state === "running" ? "In progress" : job.state === "retrying" ? "Retrying" : "Waiting"}</span></div>
      <p className="mt-1 text-muted-foreground">{job.detail}</p>
      {job.progress !== undefined && <progress className="mt-2 h-1 w-full accent-primary" max={1} value={job.progress} aria-label={`${job.label} progress`} />}
      {(job.action || job.retry || job.diagnostics) && <div className="mt-1 flex flex-wrap gap-3">{job.action ? <button type="button" className="min-h-11 min-w-11 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={job.action.run}>{job.action.label}</button> : job.retry && <button type="button" className="min-h-11 min-w-11 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={job.retry}>Try again</button>}{job.diagnostics && <button type="button" className="min-h-11 min-w-11 text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { if (!navigator.clipboard) { setCopyResult("failed"); return; } void navigator.clipboard.writeText(`${item.sourceId} · ${job.kind} · ${job.diagnostics}`).then(() => setCopyResult("copied"), () => setCopyResult("failed")); }}>Copy details</button>}</div>}
    </li>)}</ul>
    {copyResult && <p role={copyResult === "failed" ? "alert" : "status"} className="text-callout text-muted-foreground">{copyResult === "copied" ? "Details copied." : "Couldn't copy details. Try again."}</p>}
  </section>;
}, (before, after) => before.item === after.item && before.onOpenNote === after.onOpenNote && before.onClose === after.onClose && sameJobs(before.jobs, after.jobs));

export function ActivityPanel(props: { items: readonly LibraryItem[]; views: ReadonlyMap<string, NotePipelineView>; platform: AppPlatform; onOpenNote: (id: string) => void; upload?: UploadState | null; paused?: PausedUpload | null; onOpenUpload?: () => void; onContinueUpload?: () => void; onRetryUpload?: () => void; active?: boolean; placement?: "inline" | "sidebar"; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const close = useMemo(() => () => setOpen(false), []);
  const notes = useMemo(() => {
    const voice = activityNotes(props.items, props.views, props.platform);
    const file = activityForFileUpload(props.upload ?? null, props.paused ?? null, { open: props.onOpenUpload ?? (() => {}), continue: props.onContinueUpload ?? (() => {}), retry: props.onRetryUpload ?? (() => {}) });
    return file ? [...voice, { item: { id: "__file_upload__", sourceId: "__file_upload__", source: "exo-upload", title: file.title, startedAt: null, durationSecs: null } as LibraryItem, jobs: file.jobs, openLabel: "Open upload" }] : voice;
  }, [props.items, props.views, props.platform, props.upload, props.paused, props.onOpenUpload, props.onContinueUpload, props.onRetryUpload]);
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
  const retrying = notes.flatMap((note) => note.jobs).filter((job) => job.state === "retrying").length;
  const waiting = notes.flatMap((note) => note.jobs).filter((job) => job.state === "waiting").length;
  const attention = notes.flatMap((note) => note.jobs).filter((job) => job.state === "needs-attention").length;
  const grouped = (["needs-attention", "running", "retrying", "waiting"] as const).map((state) => ({ state, notes: notes.map((note) => ({ ...note, jobs: note.jobs.filter((job) => job.state === state) })).filter((note) => note.jobs.length > 0) })).filter((group) => group.notes.length > 0);
  const openNote = useCallback((id: string) => id === "__file_upload__" ? props.onOpenUpload?.() : props.onOpenNote(id), [props.onOpenUpload, props.onOpenNote]);
  useEffect(() => { if (notes.length === 0) setOpen(false); }, [notes.length]);
  if (props.active === false || notes.length === 0) return null;
  const content = (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg px-1 text-callout text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Activity: ${running} running, ${retrying} retrying, ${waiting} waiting, ${attention} need attention`} data-testid="activity-button">
          <ActivityIcon aria-hidden="true" className="size-4 shrink-0" /> <span className="tnum">{running + retrying + waiting + attention}</span>
          {running > 0 && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" data-testid="activity-indicator" />}
          {attention > 0 && <span className="tnum rounded-full bg-amber-100 px-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200" aria-hidden="true">{attention}</span>}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[27.5rem] flex-col bg-background shadow-xl focus:outline-none" data-testid="activity-panel">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <div><Dialog.Title className="text-headline">Activity</Dialog.Title><Dialog.Description className="text-callout text-muted-foreground">{running} running · {retrying} retrying · {waiting} waiting{attention > 0 ? ` · ${attention} need attention` : ""}</Dialog.Description></div>
            <Dialog.Close className="flex size-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close Activity"><XIcon aria-hidden="true" className="size-5" /></Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {notes.length === 0 ? <p className="py-8 text-callout text-muted-foreground">Nothing in progress. Everything is saved.</p> : grouped.map((group: { state: ActivityState; notes: ActivityNote[] }) => <section key={group.state} aria-label={group.state === "needs-attention" ? "Needs attention" : group.state === "running" ? "In progress" : group.state === "retrying" ? "Retrying" : "Waiting"}><h2 className="text-callout font-semibold text-muted-foreground">{group.state === "needs-attention" ? "Needs attention" : group.state === "running" ? "In progress" : group.state === "retrying" ? "Retrying" : "Waiting"} · {group.notes.reduce((sum, note) => sum + note.jobs.length, 0)}</h2>{group.notes.map(({ item, jobs, openLabel }) => <ActivityNoteSection key={`${group.state}:${item.sourceId}`} item={item} jobs={jobs} openLabel={openLabel} onOpenNote={openNote} onClose={close} />)}</section>)}
          </div>
          {(props.platform === "ios" || props.platform === "android") && <p className="border-t border-border px-4 py-3 text-callout text-muted-foreground">Uploads continue while Exo is open.</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
  const sidebarSlot = props.placement === "sidebar" && typeof document !== "undefined" ? document.querySelector("[data-activity-sidebar-slot]") : null;
  return props.placement === "sidebar" ? sidebarSlot ? createPortal(content, sidebarSlot) : null : content;
}
