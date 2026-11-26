// The CSV import block of the Connect Granola dialog: a short guide to Granola's
// export, then an upload. The file is read in the browser and stored through the
// same meeting upsert as an API sync, behind the same purge check. Strings live in
// `granolaCsvStrings.ts`.

import { useEffect, useId, useRef, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ChevronDownIcon, CheckCircle2Icon, AlertTriangleIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import * as connectorStore from "@/lib/connectors/connectorStore";
import { importGranolaCsv, type GranolaCsvImportCounts } from "@/lib/connectors/granolaCsvImport";
import {
  GRANOLA_CSV_STRINGS as S,
  GRANOLA_EXPORT_URL,
  GRANOLA_LEDGER_SOURCE,
  granolaCsvErrorMessage,
  granolaCsvErrorSummaryLines,
  granolaCsvSummaryLines,
} from "@/lib/connectors/granolaCsvStrings";
import { GranolaAllowBack } from "@/chat/GranolaAllowBack";
import { createConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";

type ImportState =
  | { phase: "idle" }
  | { phase: "importing"; done: number; total: number }
  | { phase: "done"; counts: GranolaCsvImportCounts }
  | { phase: "error"; message: string; counts: GranolaCsvImportCounts | null };

interface GranolaCsvImportProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** Another Granola action (a key connect) holds the dialog. */
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** Meetings were stored, so the caller can refresh what it shows. */
  onImported?: () => void;
}

export const GranolaCsvImport: FC<GranolaCsvImportProps> = ({
  tcw, backendUrl, sessionStore, disabled = false, onBusyChange, onImported,
}) => {
  const [guideOpen, setGuideOpen] = useState(false);
  const [state, setState] = useState<ImportState>({ phase: "idle" });
  // Held so the picker isn't collected before it answers.
  const picker = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const guideId = useId();
  useEffect(() => () => abort.current?.abort(), []);

  const busy = state.phase === "importing";
  const setBusy = (next: boolean) => onBusyChange?.(next);

  const run = async (file: File) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setState({ phase: "importing", done: 0, total: 0 });
    setBusy(true);
    try {
      const webhooks = createConnectorWebhooksClient(backendUrl, { sessionStore });
      const result = await importGranolaCsv({
        tcw,
        store: connectorStore,
        text: await file.text(),
        checkPurge: (meetingId, sourceTimestamp) => webhooks.checkPurge(meetingId, sourceTimestamp, GRANOLA_LEDGER_SOURCE),
        signal: controller.signal,
        onProgress: ({ done, total }) => {
          if (!controller.signal.aborted) setState({ phase: "importing", done, total });
        },
      });
      if (controller.signal.aborted) return;
      if (result.ok) {
        setState({ phase: "done", counts: result.data });
        if (result.data.added > 0) onImported?.();
      } else {
        setState({ phase: "error", message: granolaCsvErrorMessage(result.error), counts: result.partial });
        if (result.partial.added > 0) onImported?.();
      }
    } catch {
      if (!controller.signal.aborted) {
        setState({ phase: "error", message: granolaCsvErrorMessage({ kind: "storage", full: false }), counts: null });
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  // The picker is made on demand, so no file field sits in the dialog ahead of the API key field.
  const pickFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      picker.current = null;
      if (file) void run(file);
    }, { once: true });
    picker.current = input;
    input.click();
  };

  const skippedDeleted = state.phase === "done" ? state.counts.skippedDeleted : 0;

  return (
    <section aria-labelledby={`${guideId}-heading`} className="rounded-lg border border-border bg-muted/40 p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{S.eyebrow}</p>
      <h3 id={`${guideId}-heading`} className="mb-2 mt-1 text-base font-semibold">{S.heading}</h3>
      <Button
        type="button" variant="outline" size="sm" className="gap-2"
        aria-expanded={guideOpen} aria-controls={guideId}
        disabled={disabled || busy}
        onClick={() => setGuideOpen((open) => !open)}
      >
        {guideOpen ? S.hideSteps : S.getStarted}
        <ChevronDownIcon className={`size-3.5 transition-transform ${guideOpen ? "rotate-180" : ""}`} aria-hidden />
      </Button>
      {guideOpen && (
        <div id={guideId} className="mt-3 border-t border-border pt-3">
          <h4 className="mb-1 text-sm font-semibold">{S.guideTitle}</h4>
          <a
            href={GRANOLA_EXPORT_URL} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline underline-offset-4"
          >
            {S.exportLink}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">{S.linkFallback}</p>
          <ol className="mb-3 border-y border-border">
            {S.steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[3rem_1fr] gap-2 border-t border-border py-2 text-sm first:border-t-0">
                <span className="pt-0.5 text-xs font-semibold text-muted-foreground">{S.stepLabel(index + 1)}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <Button type="button" size="sm" disabled={disabled || busy} onClick={pickFile}>
            {S.upload}
          </Button>
        </div>
      )}

      {state.phase === "importing" && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
          {state.total > 0 ? S.importingProgress(state.done, state.total) : S.importing}
        </p>
      )}
      {state.phase === "done" && (
        <div role="status" className="mt-3 flex flex-col gap-1 text-sm">
          {granolaCsvSummaryLines(state.counts).map((line, index) => (
            <p key={line} className={index === 0 ? "flex items-center gap-2" : "text-muted-foreground"}>
              {index === 0 && <CheckCircle2Icon className="size-4 shrink-0 text-primary" aria-hidden />}
              {line}
            </p>
          ))}
        </div>
      )}
      {state.phase === "error" && (
        <div className="mt-3 flex flex-col gap-1 text-sm">
          <p role="alert" className="flex items-start gap-2 text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{state.message}</span>
          </p>
          {state.counts && granolaCsvErrorSummaryLines(state.counts).map((line) => (
            <p key={line} className="text-muted-foreground">{line}</p>
          ))}
        </div>
      )}

      {skippedDeleted > 0 && (
        <GranolaAllowBack className="mt-1" tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />
      )}
    </section>
  );
};
