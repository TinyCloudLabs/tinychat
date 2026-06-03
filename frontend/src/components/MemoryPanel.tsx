import { useCallback, useEffect, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { BrainIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  clearMemory,
  getMemory,
  memoryWriteGen,
  readMemoryCache,
  setMemory,
} from "@/lib/threadStore";
import { MEMORY_BUDGET_CHARS, clampDocToBudget } from "@/lib/memory";

interface MemoryPanelProps {
  tcw: TinyCloudWeb;
  /** Live ref the runtime reads at model-context request time. */
  memoryRef: React.MutableRefObject<string | null>;
  /**
   * Bubbled to the parent so other surfaces can re-render. `null` means the
   * doc was cleared; a string carries the latest content. Consumers today
   * only watch for any change (to bump a version counter).
   */
  onMemoryUpdated?: (doc: string | null) => void;
  /** Close the popover after the user finishes an action. */
  onClose?: () => void;
  /**
   * Bubbled when the dirty (unsaved-edits) state changes. The popover host
   * consults this in its Escape / click-outside handlers so a user does not
   * silently lose in-progress edits.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * "What the assistant remembers" panel — the transparency contract for the
 * per-space memory doc.
 *
 * View, edit (textarea → setMemory), and Clear (clearMemory). Reads from
 * SQL on mount but seeds from the localStorage cache for instant paint —
 * the doc is a few-KB string so the cache is always cheap.
 */
export function MemoryPanel({
  tcw,
  memoryRef,
  onMemoryUpdated,
  onClose,
  onDirtyChange,
}: MemoryPanelProps) {
  const [doc, setDoc] = useState<string | null>(() => memoryRef.current ?? readMemoryCache(tcw));
  const [draft, setDraft] = useState<string>(() => doc ?? "");
  const [loading, setLoading] = useState<boolean>(doc === null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [justTrimmed, setJustTrimmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const initialDocRef = useRef<string>(doc ?? "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Move focus into the panel on mount so screen-reader users hear the
  // dialog appear. Prefer the textarea (primary action surface) once loaded;
  // fall back to the Close button while loading.
  useEffect(() => {
    if (loading) {
      closeButtonRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [loading]);

  // Reconcile from SQL on mount — the cache may be stale if another device
  // edited the doc. Updates the ref + draft only if the SQL row differs.
  // Race guard: skip the ref assignment if a write happened during the read
  // (extraction or another save), so the stale SQL value can't roll back a
  // newer ref. See memoryWriteGen in threadStore.
  useEffect(() => {
    let cancelled = false;
    const startGen = memoryWriteGen();
    setLoading(memoryRef.current === null && readMemoryCache(tcw) === null);
    (async () => {
      try {
        const fresh = await getMemory(tcw);
        if (cancelled) return;
        if (fresh !== null && memoryWriteGen() === startGen) {
          memoryRef.current = fresh;
          setDoc(fresh);
          // Don't clobber an in-progress edit: only sync the draft when the
          // user hasn't touched it (still matches the initial view captured
          // when the panel opened).
          setDraft((prev) => (prev === initialDocRef.current ? fresh : prev));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load memory");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tcw, memoryRef]);

  const isEmpty = !doc || doc.trim().length === 0;
  const dirty = draft !== (doc ?? "");
  const overBudget = draft.length > MEMORY_BUDGET_CHARS;

  // Closing with unsaved edits must not silently discard them. Escape and
  // click-outside already keep the panel open while dirty (see MemoryPopover);
  // the explicit Close button is the remaining path, so route it through a
  // confirm dialog instead of dropping the draft.
  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose?.();
  }, [dirty, onClose]);

  // Bubble dirty changes to the popover host so it can keep the panel open
  // while the user has unsaved edits.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // One-shot live-region message for the over-budget transition. Re-typing
  // every keystroke would chatter; this only fires on the false → true edge.
  const [budgetAnnouncement, setBudgetAnnouncement] = useState("");
  const prevOverBudgetRef = useRef(false);
  useEffect(() => {
    if (overBudget && !prevOverBudgetRef.current) {
      setBudgetAnnouncement("Over limit — oldest notes will be trimmed on save.");
    } else if (!overBudget && prevOverBudgetRef.current) {
      setBudgetAnnouncement("");
    }
    prevOverBudgetRef.current = overBudget;
  }, [overBudget]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Match what gets injected: persist the clamped doc so re-opening the
      // panel shows the same text the model will see at inject time.
      const next = clampDocToBudget(draft);
      const trimmed = next.length < draft.length;
      await setMemory(tcw, next);
      memoryRef.current = next;
      setDoc(next);
      setDraft(next);
      onMemoryUpdated?.(next);
      setJustTrimmed(trimmed);
      setJustSaved(true);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "AUTH_UNAUTHORIZED") {
        setError("Session expired — please sign in again to save memory.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to save memory");
      }
    } finally {
      setSaving(false);
    }
  }, [draft, dirty, saving, tcw, memoryRef, onMemoryUpdated]);

  // Clear the "Saved" flash ~1.5s after a successful save. Bump to ~3s when
  // the save also trimmed content, so the user has a chance to notice that
  // the visible text shortened.
  useEffect(() => {
    if (!justSaved) return;
    const t = window.setTimeout(() => {
      setJustSaved(false);
      setJustTrimmed(false);
    }, justTrimmed ? 3000 : 1500);
    return () => window.clearTimeout(t);
  }, [justSaved, justTrimmed]);

  // Drop the "Saved" flash as soon as the user edits again.
  useEffect(() => {
    if (justSaved && dirty) {
      setJustSaved(false);
      setJustTrimmed(false);
    }
  }, [justSaved, dirty]);

  const clear = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await clearMemory(tcw);
      // Match the sign-out convention: null means "no doc". hasContent treats
      // null and "" the same, so this is purely a semantic clarification.
      memoryRef.current = null;
      setDoc("");
      setDraft("");
      onMemoryUpdated?.(null);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "AUTH_UNAUTHORIZED") {
        setError("Session expired — please sign in again to clear memory.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to clear memory");
      }
    } finally {
      setSaving(false);
    }
  }, [tcw, memoryRef, onMemoryUpdated]);

  return (
    <div
      ref={rootRef}
      id="memory-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-panel-title"
      className="flex max-h-[min(36rem,90vh)] w-[min(420px,90vw)] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span
            id="memory-panel-title"
            className="flex items-center gap-1.5 text-sm font-semibold tracking-tight"
          >
            <BrainIcon className="size-3.5 text-muted-foreground" />
            What the assistant remembers
          </span>
          <span className="text-xs text-muted-foreground">
            Stored in your TinyCloud space. Edit or clear at any time.
          </span>
        </div>
        {onClose && (
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="sm"
            onClick={requestClose}
            className="-mr-1 -mt-1 h-7 px-2 text-xs"
          >
            Close
          </Button>
        )}
      </div>

      {dirty && (
        <p
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          Unsaved changes — save or revert before closing.
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-6 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading memory…
        </div>
      ) : (
        <>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            spellCheck={false}
            aria-label="Memory document"
            placeholder={
              "# About the user\n## Identity & background\n- (the assistant will fill this in over time)"
            }
            className="min-h-40 max-h-[min(16rem,40vh)] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              {draft.length.toLocaleString()} / {MEMORY_BUDGET_CHARS.toLocaleString()} chars
              {overBudget && (
                <span className="ml-1.5 text-destructive">
                  over limit — oldest notes will be trimmed to fit (entries under
                  &ldquo;Recent activity&rdquo; go first)
                </span>
              )}
            </span>
            {isEmpty && !dirty && <span>empty — nothing injected yet</span>}
          </div>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {budgetAnnouncement}
          </span>
        </>
      )}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={isEmpty || saving}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Clear memory
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear memory?</AlertDialogTitle>
              <AlertDialogDescription>
                The assistant will forget everything it has learned about you in this space. This
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={clear}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Clear
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex items-center gap-2">
          {dirty && (
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => setDraft(doc ?? "")}
            >
              Revert
            </Button>
          )}
          {/*
           * Hoist the live region: keep the element mounted at all times so
           * VoiceOver / NVDA register it before the text changes. Conditional
           * mounting + aria-live is not reliably announced.
           */}
          <span
            className="text-xs text-muted-foreground"
            aria-live="polite"
            aria-atomic="true"
          >
            {justSaved && !dirty && !saving
              ? (justTrimmed ? "Saved (trimmed to fit budget)" : "Saved")
              : ""}
          </span>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={save}
            title="Save (⌘/Ctrl + Enter)"
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {saving ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin" />
                Saving
              </>
            ) : (
              <>
                Save
                <kbd
                  aria-hidden
                  className="ml-1 hidden rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground sm:inline"
                >
                  ⌘↵
                </kbd>
              </>
            )}
          </Button>
        </div>
      </div>

      {/*
       * Controlled confirm for closing with unsaved edits. The host's
       * Escape/click-outside handlers already detect this open alertdialog
       * (role="alertdialog"[data-state="open"]) and defer to it, so the
       * popover stays put until the user decides.
       */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to the memory document haven&rsquo;t been saved. Close and discard them?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmClose(false);
                onClose?.();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
