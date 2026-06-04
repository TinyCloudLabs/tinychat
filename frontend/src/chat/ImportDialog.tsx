import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { AlertTriangleIcon, Loader2Icon, UploadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  parseClaudeExport,
  toStoredItem,
  type NormalizedConversation,
} from "@/lib/claudeImport";
import {
  clearThreadIndexCache,
  importThread,
  listThreads,
} from "@/lib/threadStore";

// Spec §5: thread id is `claude-<uuid>` (stable across re-imports).
const CLAUDE_THREAD_PREFIX = "claude-";

const ACCEPTED_EXTENSIONS = ".json,.jsonl,.zip";

type Phase = "idle" | "parsing" | "ready" | "importing" | "done" | "error";

interface PickRow {
  conv: NormalizedConversation;
  threadId: string;
  alreadyImported: boolean;
}

interface ImportFailure {
  title: string;
  reason: string;
}

interface ImportSummary {
  imported: number;
  failed: number;
  canceled: number;
  unselected: number;
  alreadyImportedSkipped: number;
  failures: ImportFailure[];
}

// Spec §10: each conversation is a ~2s signed round-trip. Warn the user
// before kicking off a batch they can't bail out of mid-loop.
const LARGE_IMPORT_THRESHOLD = 50;
const SECONDS_PER_CONVERSATION = 2;

interface ImportDialogProps {
  tcw: TinyCloudWeb;
  /**
   * Called after the user acknowledges the done summary. Fires on the Done
   * click (not on import finish) so the carefully built imported/skipped/failed
   * counts paint before any caller-triggered refresh discards them.
   */
  onImported?: () => void;
}

export const ImportDialog: FC<ImportDialogProps> = ({ tcw, onImported }) => {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PickRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Mid-batch cancel flag — flipped by the Cancel button during `importing`
  // and checked at the top of each loop iteration.
  const cancelRequestedRef = useRef(false);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setRows([]);
    setSelected(new Set());
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    cancelRequestedRef.current = false;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Don't let the user close mid-import — SQL writes are sequential and a
  // disposed dialog mid-loop strands a half-imported batch.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (phase === "importing") return;
      setOpen(next);
      if (!next) reset();
    },
    [phase, reset],
  );

  const openFilePicker = useCallback(() => {
    // microtask: input may be re-mounted by the phase transition.
    queueMicrotask(() => {
      fileInputRef.current?.click();
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setPhase("parsing");
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // listThreads is contracted not to throw — any cold-path failure logs
        // and returns the cached value (or []). We rely on that here.
        const existing = await listThreads(tcw);
        const convs = await parseClaudeExport(bytes);
        if (convs.length === 0) {
          setError(
            "Parsed 0 conversations. Make sure this is a Claude export (.json, .jsonl, or .zip).",
          );
          setPhase("error");
          return;
        }
        const existingIds = new Set(existing.map((t) => t.id));
        // Show newest first. The export file's order is not guaranteed (Claude's
        // .json is usually newest-first, but .jsonl / reordered exports are not),
        // so sort explicitly to mirror the sidebar (threads by updated_at DESC).
        const ordered = [...convs].sort((a, b) => {
          const ta = Date.parse(a.createdAt);
          const tb = Date.parse(b.createdAt);
          if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
          if (Number.isNaN(ta)) return 1; // undated rows sink to the bottom
          if (Number.isNaN(tb)) return -1;
          return tb - ta;
        });
        const pickRows: PickRow[] = ordered.map((conv) => {
          const threadId = `${CLAUDE_THREAD_PREFIX}${conv.sourceId}`;
          return {
            conv,
            threadId,
            alreadyImported: existingIds.has(threadId),
          };
        });
        // Default selection: every conversation not flagged as already imported.
        const defaultSelected = new Set(
          pickRows.filter((r) => !r.alreadyImported).map((r) => r.threadId),
        );
        setRows(pickRows);
        setSelected(defaultSelected);
        setPhase("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read this file.");
        setPhase("error");
      }
    },
    [tcw],
  );

  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const toggleRow = useCallback((threadId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.threadId)),
    );
  }, [rows]);

  const runImport = useCallback(async () => {
    const chosen = rows.filter((r) => selected.has(r.threadId));
    if (chosen.length === 0) return;
    setPhase("importing");
    setProgress({ done: 0, total: chosen.length });
    cancelRequestedRef.current = false;

    // Spec §6: bulk import must not leave a partial `tinychat:index` cache.
    // Clear up FRONT too so a tab close mid-loop leaves an empty (cold) cache
    // rather than a partial one — the per-row patches in importThread become
    // no-ops once the cache is gone, then we clear again at the end as
    // belt-and-suspenders.
    clearThreadIndexCache(tcw);

    let imported = 0;
    let canceled = 0;
    const failures: ImportFailure[] = [];
    // SEQUENTIAL — TinyCloud SQL drops concurrent responses, so an import loop
    // that fires in parallel would silently lose writes.
    for (const row of chosen) {
      if (cancelRequestedRef.current) {
        canceled++;
        continue;
      }
      try {
        const items = row.conv.messages.map((m, i) =>
          toStoredItem(m.role, m.text, m.createdAt, i, row.threadId),
        );
        await importThread(tcw, {
          id: row.threadId,
          title: row.conv.title,
          createdAt: row.conv.createdAt,
          updatedAt: row.conv.updatedAt,
          items,
        });
        imported++;
      } catch (err) {
        console.error("[ImportDialog] import failed", row.threadId, err);
        failures.push({
          title: row.conv.title,
          reason: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    }

    clearThreadIndexCache(tcw);

    const unselectedRows = rows.filter((r) => !selected.has(r.threadId));
    const alreadyImportedSkipped = unselectedRows.filter(
      (r) => r.alreadyImported,
    ).length;
    setSummary({
      imported,
      failed: failures.length,
      canceled,
      unselected: unselectedRows.length - alreadyImportedSkipped,
      alreadyImportedSkipped,
      failures,
    });
    setPhase("done");
    // NOTE: do not fire onImported here — the parent may reload the page,
    // racing the Done summary off-screen. Fire it from the Done button click.
  }, [rows, selected, tcw]);

  const onDoneClick = useCallback(() => {
    setOpen(false);
    reset();
    onImported?.();
  }, [reset, onImported]);

  const onChooseAnother = useCallback(() => {
    reset();
    openFilePicker();
  }, [reset, openFilePicker]);

  const selectedCount = selected.size;
  const replaceCount = useMemo(
    () =>
      rows.filter((r) => r.alreadyImported && selected.has(r.threadId)).length,
    [rows, selected],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <UploadIcon className="size-4" />
          Import
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-w-lg sm:max-w-2xl"
        // Hide the built-in X while a batch is in flight (matches the
        // handleOpenChange guard) so the user can't strand a half-imported run.
        hideCloseButton={phase === "importing"}
      >
        <DialogHeader>
          <DialogTitle>Import Claude history</DialogTitle>
          <DialogDescription>
            Upload your Claude export (.json, .jsonl, or .zip), then pick the
            conversations to add to this space.
          </DialogDescription>
        </DialogHeader>

        {(phase === "idle" || phase === "parsing" || phase === "error") && (
          <FilePicker
            fileInputRef={fileInputRef}
            onChange={onFileInputChange}
            onDrop={onDrop}
            parsing={phase === "parsing"}
            error={error}
          />
        )}

        {phase === "ready" && (
          <PickList
            rows={rows}
            selected={selected}
            allSelected={allSelected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
            replaceCount={replaceCount}
            largeImport={selectedCount > LARGE_IMPORT_THRESHOLD}
            estimatedSeconds={selectedCount * SECONDS_PER_CONVERSATION}
          />
        )}

        {phase === "importing" && (
          <ImportProgress done={progress.done} total={progress.total} />
        )}

        {phase === "done" && summary && (
          <DoneSummary summary={summary} />
        )}

        <ImportDialogFooter
          phase={phase}
          selectedCount={selectedCount}
          replaceCount={replaceCount}
          onClose={() => handleOpenChange(false)}
          onConfirm={runImport}
          onChooseAnother={onChooseAnother}
          onCancelImport={() => {
            cancelRequestedRef.current = true;
          }}
          onDone={onDoneClick}
        />
      </DialogContent>
    </Dialog>
  );
};

// ── Sub-views ────────────────────────────────────────────────────────

const FilePicker: FC<{
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: React.DragEvent<HTMLLabelElement>) => void;
  parsing: boolean;
  error: string | null;
}> = ({ fileInputRef, onChange, onDrop, parsing, error }) => {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          onDrop(e);
        }}
        className={
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-4 py-8 text-sm text-muted-foreground transition-colors hover:bg-muted/50" +
          (parsing ? " pointer-events-none opacity-60" : "") +
          (dragging ? " border-primary bg-accent" : "")
        }
      >
        {parsing ? (
          <>
            <Loader2Icon className="size-5 animate-spin" />
            Reading file…
          </>
        ) : (
          <>
            <UploadIcon className="size-5" />
            <span>Click or drop a Claude export</span>
            <span className="text-xs">.json, .jsonl, or .zip</span>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          className="sr-only"
          onChange={onChange}
          disabled={parsing}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};

const PickList: FC<{
  rows: PickRow[];
  selected: Set<string>;
  allSelected: boolean;
  onToggleRow: (threadId: string) => void;
  onToggleAll: () => void;
  replaceCount: number;
  largeImport: boolean;
  estimatedSeconds: number;
}> = ({
  rows,
  selected,
  allSelected,
  onToggleRow,
  onToggleAll,
  replaceCount,
  largeImport,
  estimatedSeconds,
}) => {
  const importedCount = useMemo(
    () => rows.filter((r) => r.alreadyImported).length,
    [rows],
  );
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  // Tri-state: a partial selection should render as indeterminate, not unchecked.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selected.size > 0 && selected.size < rows.length;
    }
  }, [selected.size, rows.length]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-2 text-foreground">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allSelected}
            onChange={onToggleAll}
            className="size-4 cursor-pointer accent-primary"
          />
          {allSelected ? "Deselect all" : "Select all"}
        </label>
        <span>
          {selected.size} of {rows.length} selected
          {importedCount > 0 ? ` · ${importedCount} already imported` : ""}
        </span>
      </div>
      <ul
        aria-label="Conversations to import"
        className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-background p-1 sm:max-h-[60vh]"
      >
        {rows.map((row) => (
          <li key={row.threadId}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent">
              <input
                type="checkbox"
                checked={selected.has(row.threadId)}
                onChange={() => onToggleRow(row.threadId)}
                className="size-4 shrink-0 cursor-pointer accent-primary"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">{row.conv.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {formatDate(row.conv.createdAt)} ·{" "}
                  {row.conv.messages.length} message
                  {row.conv.messages.length === 1 ? "" : "s"}
                </span>
              </div>
              {row.alreadyImported && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                  Already imported
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
      {replaceCount > 0 && (
        <p
          role="status"
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {replaceCount} selected row{replaceCount === 1 ? "" : "s"} will
            replace existing messages.
          </span>
        </p>
      )}
      {largeImport && (
        <p className="text-xs text-muted-foreground">
          Importing {selected.size} conversations will take roughly{" "}
          {formatEstimate(estimatedSeconds)}. Leave this dialog open.
        </p>
      )}
    </div>
  );
};

const ImportProgress: FC<{ done: number; total: number }> = ({ done, total }) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  // Throttle SR announcements to every ~10% of the run (min 1) so a 50-row
  // batch doesn't spew 50 polite messages. Keep the visible counter updating
  // every tick — the throttle is in the hidden live region's content only.
  const announceEvery = Math.max(1, Math.ceil(total / 10));
  const announcedDone =
    done === total ? done : Math.floor(done / announceEvery) * announceEvery;
  return (
    <div className="flex flex-col gap-2 py-4">
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Importing {done} / {total}…
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Imported {announcedDone} of {total}
        {announcedDone === total ? ". Done." : "…"}
      </p>
    </div>
  );
};

const DoneSummary: FC<{ summary: ImportSummary }> = ({ summary }) => (
  <div className="flex flex-col gap-1 py-2 text-sm">
    <p className="text-foreground">
      Imported {summary.imported} conversation
      {summary.imported === 1 ? "" : "s"}.
    </p>
    {summary.alreadyImportedSkipped > 0 && (
      <p className="text-muted-foreground">
        Skipped {summary.alreadyImportedSkipped} already in your space.
      </p>
    )}
    {summary.unselected > 0 && (
      <p className="text-muted-foreground">
        Skipped {summary.unselected} not selected.
      </p>
    )}
    {summary.canceled > 0 && (
      <p className="text-muted-foreground">
        Canceled {summary.canceled} before they started.
      </p>
    )}
    {summary.failures.length > 0 && (
      <details className="mt-1 text-destructive">
        <summary className="cursor-pointer">
          Failed: {summary.failures.length}. Show details
        </summary>
        <ul className="mt-1 space-y-1 pl-4 text-xs">
          {summary.failures.map((f, i) => (
            <li key={i}>
              <span className="font-medium">{f.title}:</span> {f.reason}
            </li>
          ))}
        </ul>
      </details>
    )}
  </div>
);

const ImportDialogFooter: FC<{
  phase: Phase;
  selectedCount: number;
  replaceCount: number;
  onClose: () => void;
  onConfirm: () => void;
  onChooseAnother: () => void;
  onCancelImport: () => void;
  onDone: () => void;
}> = ({
  phase,
  selectedCount,
  replaceCount,
  onClose,
  onConfirm,
  onChooseAnother,
  onCancelImport,
  onDone,
}) => (
  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    {phase === "ready" && (
      <>
        <Button variant="outline" size="sm" onClick={onChooseAnother}>
          Choose another file
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={selectedCount === 0}
        >
          Import {selectedCount} conversation{selectedCount === 1 ? "" : "s"}
          {replaceCount > 0
            ? ` (${replaceCount} will replace)`
            : ""}
        </Button>
      </>
    )}
    {(phase === "idle" || phase === "parsing" || phase === "error") && (
      <Button variant="outline" size="sm" onClick={onClose}>
        Cancel
      </Button>
    )}
    {phase === "importing" && (
      <Button variant="outline" size="sm" onClick={onCancelImport}>
        Cancel remaining
      </Button>
    )}
    {phase === "done" && (
      <Button size="sm" onClick={onDone}>
        Done
      </Button>
    )}
  </div>
);

function formatEstimate(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatDate(iso: string): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
