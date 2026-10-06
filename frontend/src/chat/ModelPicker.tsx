import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ShieldCheckIcon, ShieldIcon } from "lucide-react";

import { BottomSheet, BottomSheetBody } from "@/components/ui/bottom-sheet";
import { cn } from "@/lib/utils";
import { isResponseVerifiableModel, isTeeCapableModel } from "../lib/completionStore";
import { ModelVerificationIndicator } from "./ModelVerificationIndicator";

export interface ModelOption {
  id: string;
  /** When the paywall is on, whether the current tier may use this model. */
  allowed?: boolean;
  requiredTier?: "plus" | "pro";
  /** Per-model credit rates (spec §5.4 — always present from /api/chat/models). */
  creditsPerKInput?: number;
  creditsPerKOutput?: number;
  multiplier?: number;
  /**
   * Context window in tokens (spec §D.4). Plumbed from /api/chat/models so the
   * adapter can size compaction; absent → DEFAULT_CONTEXT_TOKENS via
   * contextTokensFor below.
   */
  contextLength?: number;
}

function ModelShield({ id, className }: { id: string; className?: string }) {
  if (isResponseVerifiableModel(id)) {
    return <ShieldCheckIcon aria-label="Response verified" className={cn("text-emerald-600 dark:text-emerald-400", className)} />;
  }
  if (isTeeCapableModel(id)) return <ShieldIcon aria-label="TEE capable" className={cn("text-muted-foreground", className)} />;
  return null;
}

function Multiplier({ value }: { value: number | undefined }) {
  return typeof value === "number" ? (
    <span className="rounded-full bg-selected px-1.5 py-0.5 text-label font-semibold tabular-nums text-primary">
      {Number.parseFloat(value.toFixed(1))}×
    </span>
  ) : (
    <span className="text-label text-muted-foreground">Rates unavailable</span>
  );
}

/**
 * The model chip in the composer's toolbar. On wide screens it opens a list
 * above the chip; on phones (`sheet`) a bottom sheet titled Model, with the
 * model's verification indicator at its top (the chat header shows it on wide
 * screens).
 */
export function ModelPicker(props: {
  model: string | null;
  models: ModelOption[];
  disabled: boolean;
  status?: string;
  onPick: (id: string) => void;
  presentation?: "popover" | "sheet";
}) {
  const { model, models, disabled, status, onPick, presentation = "popover" } = props;
  const sheet = presentation === "sheet";
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The popover closes on an outside press and on Escape; the sheet has its own.
  useEffect(() => {
    if (!open || sheet) return;
    const onPointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, sheet]);

  useEffect(() => {
    if (!open || models.length === 0) return;
    const active = Math.max(0, models.findIndex((entry) => entry.id === model));
    setFocusedIndex(active);
    queueMicrotask(() => optionRefs.current[active]?.focus());
  }, [open, model, models]);

  const select = (id: string) => {
    onPick(id);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (models.length === 0) return;
    let next: number;
    if (event.key === "ArrowDown") next = (focusedIndex + 1) % models.length;
    else if (event.key === "ArrowUp") next = (focusedIndex - 1 + models.length) % models.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = models.length - 1;
    else if ((event.key === "Enter" || event.key === " ") && models[focusedIndex]) {
      event.preventDefault();
      select(models[focusedIndex]!.id);
      return;
    } else return;
    event.preventDefault();
    setFocusedIndex(next);
    optionRefs.current[next]?.focus();
  };

  const options = models.map((entry, index) => {
    const active = entry.id === model;
    return (
      <button
        key={entry.id}
        ref={(element) => {
          optionRefs.current[index] = element;
        }}
        type="button"
        role="option"
        aria-selected={active}
        tabIndex={focusedIndex === index ? 0 : -1}
        onClick={() => select(entry.id)}
        onFocus={() => setFocusedIndex(index)}
        className={cn(
          "tap-transparent flex w-full items-center gap-2.5 text-left outline-none transition-colors focus-visible:bg-surface-2",
          sheet ? "min-h-14 rounded-lg px-3 text-callout active:bg-surface-2" : "min-h-11 rounded-md px-2.5 text-meta hover:bg-surface-2 fine:min-h-9",
          active && "bg-selected font-semibold",
        )}
      >
        <CheckIcon aria-hidden className={cn("size-4 shrink-0 text-primary", !active && "invisible")} />
        <span className={cn("min-w-0 flex-1", sheet ? "[overflow-wrap:anywhere]" : "truncate")}>{entry.id}</span>
        <ModelShield id={entry.id} className="size-3.5 shrink-0" />
        <Multiplier value={entry.multiplier} />
      </button>
    );
  });

  return (
    <div className="relative flex min-w-0 items-center gap-2" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup={sheet ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-controls={sheet ? undefined : "model-picker-popup"}
        aria-label="Model"
        title={status}
        className="tap-transparent flex min-h-11 min-w-0 max-w-full shrink items-center gap-1.5 rounded-[1.375rem] border border-input py-1 pl-3 pr-2.5 text-meta text-foreground transition-colors hover:bg-surface-2 active:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60 fine:min-h-8 fine:rounded-2xl"
      >
        {model && <ModelShield id={model} className="size-3.5 shrink-0" />}
        {/* Two lines at most, so large text wraps the name instead of hiding it. */}
        <span className="line-clamp-2 min-w-0 max-w-[9rem] text-left leading-tight [overflow-wrap:anywhere] fine:max-w-[14rem]">
          {model ?? status ?? "Choosing model…"}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {model && status && (
        <span role="status" className="min-w-0 truncate text-meta text-muted-foreground">
          {status}
        </span>
      )}
      {sheet ? (
        <BottomSheet open={open} onOpenChange={setOpen} title="Model" contentProps={{ "data-testid": "model-sheet" }}>
          <BottomSheetBody>
            {model && (
              <div className="pb-3">
                <ModelVerificationIndicator model={model} layout="inline" />
              </div>
            )}
            <div id="model-picker-popup" role="listbox" aria-label="Model" onKeyDown={onListKeyDown} className="flex flex-col gap-0.5">
              {options}
            </div>
          </BottomSheetBody>
        </BottomSheet>
      ) : (
        open && (
          <div
            id="model-picker-popup"
            role="listbox"
            aria-label="Model"
            data-overlay-open="true"
            onKeyDown={onListKeyDown}
            className="absolute bottom-full left-0 z-40 mb-2 max-h-72 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-float"
          >
            {options}
          </div>
        )
      )}
    </div>
  );
}
