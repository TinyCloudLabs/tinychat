// TC-1152 v1b-b: runs the summary of combined meetings and remembers what each run is doing.
//
// One runner per signed-in space (CaptureSurface owns it). A run is started by a combine / Re-combine
// (`start`, when automatic summaries are on) or by the user's Generate / Retry (`retry`). Opening a page never
// starts one, so reopening a meeting costs no call. At most one run per meeting at a time: `retry` while one
// runs does nothing, and a Re-combine replaces the old run (its result is dropped).
//
// A run reads the combined body from the space, calls `generateSummary` (the chat route, billed to the
// user), and writes ONLY the two summary columns (`writeCombinedSummary`, one UPDATE). Any failure leaves
// the combine untouched and the meeting without a summary ("Summary unavailable · Retry"). It logs
// nothing: no transcript text, no model text, no error message; the result is a kind and counts.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ContextOverflowError, PaywallError } from "@/lib/chatApi";
import { readCombinedBody, readCombinedSummary, writeCombinedSummary } from "@/lib/connectors/combinedMeetingStore";

import { generateSummary, type CallFailure, type GenerateDeps, type SummaryFailureKind } from "./generateSummary";
import { transcriptLines } from "./summaryPrompt";
import { actionItemsFromColumn, actionItemsToColumn, overviewFromColumn, type ParsedSummary } from "./summaryText";

export type SummaryUnavailableReason = "failed" | "too_long" | "paywall";

export type SummaryView =
  /** The stored summary is being read. */
  | { status: "loading" }
  | { status: "generating" }
  | { status: "ready"; overview: string; actionItems: string[] }
  /** Stored with no summary and no run here: the user can Generate one. */
  | { status: "idle" }
  | { status: "unavailable"; reason: SummaryUnavailableReason };

export interface SummaryRunnerDeps {
  /** The signed-in account's space, behind its queue (scheduledSpace). */
  space: TinyCloudWeb;
  complete: GenerateDeps["complete"];
  classify?: GenerateDeps["classify"];
  /** Called when a run ends (saved, failed, or cancelled). A run that reached the model has spent credits. */
  onSettled?: () => void;
}

export interface SummaryRunner {
  /** A combine or Re-combine wrote this row: (re)generate. `replacing` is a Re-combine (an old summary may exist). */
  start: (id: string, options: { replacing: boolean }) => void;
  /** The user's Generate / Retry. Does nothing while a run is in flight. */
  retry: (id: string) => void;
  /** A Re-combine with automatic summaries off: drop the old summary of the old text; no run starts. */
  clear: (id: string) => void;
  /** What the run for `id` is doing; undefined when there is no run in this session. Stable between changes. */
  view: (id: string) => SummaryView | undefined;
  subscribe: (listener: () => void) => () => void;
  /** Stop every run and forget them (another account, or unmount). */
  cancelAll: () => void;
}

interface Job {
  view: SummaryView;
  controller: AbortController;
  /** Generated but not saved: a Retry saves it without another model call. */
  pending: ParsedSummary | null;
}

export const classifyChatError: GenerateDeps["classify"] = (error): CallFailure =>
  error instanceof PaywallError ? "paywall" : error instanceof ContextOverflowError ? "overflow" : "other";

const REASON: Partial<Record<SummaryFailureKind, SummaryUnavailableReason>> = { paywall: "paywall", too_long: "too_long" };

export function createSummaryRunner(deps: SummaryRunnerDeps): SummaryRunner {
  const jobs = new Map<string, Job>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const classify = deps.classify ?? classifyChatError;

  const set = (id: string, job: Job) => { jobs.set(id, job); notify(); };
  const current = (id: string, controller: AbortController) => jobs.get(id)?.controller === controller;
  const ready = (summary: ParsedSummary): SummaryView => ({ status: "ready", overview: summary.overview, actionItems: summary.actionItems });

  const save = async (id: string, summary: ParsedSummary, controller: AbortController): Promise<void> => {
    const written = await writeCombinedSummary(deps.space, id, { overview: summary.overview, actionItems: actionItemsToColumn(summary.actionItems) });
    if (!current(id, controller)) return;
    set(id, written.ok
      ? { view: ready(summary), controller, pending: null }
      : { view: { status: "unavailable", reason: "failed" }, controller, pending: summary });
  };

  const run = async (id: string, replacing: boolean, controller: AbortController): Promise<void> => {
    const unavailable = (reason: SummaryUnavailableReason) => {
      if (current(id, controller)) set(id, { view: { status: "unavailable", reason }, controller, pending: null });
    };
    try {
      // A Re-combine's old summary is of the old text: clear it FIRST, so however this run ends (a failure, a
      // cancel, the app closing) the page never shows it as the summary of the new text.
      if (replacing) {
        const cleared = await writeCombinedSummary(deps.space, id, { overview: null, actionItems: null });
        if (!current(id, controller)) return;
        if (!cleared.ok) return unavailable("failed");
      }
      const row = await readCombinedSummary(deps.space, id);
      if (!current(id, controller)) return;
      if (!row.ok || row.data === null) return unavailable("failed");
      const body = await readCombinedBody(deps.space, row.data.sourceId);
      if (!current(id, controller)) return;
      if (!body.ok) return unavailable("failed");
      const result = await generateSummary(transcriptLines(body.data), { complete: deps.complete, classify, signal: controller.signal });
      if (!current(id, controller)) return;
      if (!result.ok) return unavailable(REASON[result.kind] ?? "failed");
      await save(id, result.summary, controller);
    } catch {
      unavailable("failed");
    } finally {
      deps.onSettled?.();
    }
  };

  const begin = (id: string, replacing: boolean) => {
    jobs.get(id)?.controller.abort();
    const controller = new AbortController();
    set(id, { view: { status: "generating" }, controller, pending: null });
    void run(id, replacing, controller);
  };

  return {
    start: (id, options) => begin(id, options.replacing),
    retry: (id) => {
      const job = jobs.get(id);
      if (job?.view.status === "generating") return;
      if (job?.pending) {
        const controller = new AbortController();
        const pending = job.pending;
        set(id, { view: { status: "generating" }, controller, pending });
        void save(id, pending, controller);
        return;
      }
      begin(id, false);
    },
    clear: (id) => {
      jobs.get(id)?.controller.abort();
      jobs.delete(id);
      notify();
      void writeCombinedSummary(deps.space, id, { overview: null, actionItems: null }).then((written) => {
        // A failed clear must not leave the old summary showing: the page shows Retry instead of the stale text.
        if (!written.ok) set(id, { view: { status: "unavailable", reason: "failed" }, controller: new AbortController(), pending: null });
      });
    },
    view: (id) => jobs.get(id)?.view,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancelAll: () => {
      for (const job of jobs.values()) job.controller.abort();
      jobs.clear();
      notify();
    },
  };
}

/** What a stored row shows when no run is going: its summary, or nothing yet (the user can Generate one). */
export function storedSummaryView(row: { overview: string | null; actionItems: string | null }): SummaryView {
  const overview = overviewFromColumn(row.overview);
  return overview !== null
    ? { status: "ready", overview, actionItems: actionItemsFromColumn(row.actionItems) }
    : { status: "idle" };
}
