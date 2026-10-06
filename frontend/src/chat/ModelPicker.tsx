import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ShieldCheckIcon, ShieldIcon } from "lucide-react";
import { isResponseVerifiableModel, isTeeCapableModel } from "../lib/completionStore";

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

export function ModelPicker(props: {
  model: string | null;
  models: ModelOption[];
  disabled: boolean;
  status?: string;
  onPick: (id: string) => void;
}) {
  const { model, models, disabled, status, onPick } = props;
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

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

  return (
    <div className="relative min-w-0" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="model-picker-popup"
        aria-label="Model"
        title={status}
        className="flex h-11 max-w-full items-center gap-1.5 rounded-md border border-input bg-background pl-2.5 pr-2 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 md:h-8"
      >
        {model && isResponseVerifiableModel(model) ? (
          <ShieldCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : model && isTeeCapableModel(model) ? (
          <ShieldIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        <span className="max-w-[7rem] truncate sm:max-w-[12rem]">
          {model ?? status ?? "Choosing model…"}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          id="model-picker-popup"
          role="listbox"
          aria-label="Model"
          onKeyDown={onListKeyDown}
          className="absolute left-0 z-30 mt-1.5 max-h-72 w-80 max-w-[calc(100vw-6.5rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs shadow-lg"
        >
          {models.map((entry, index) => {
            const active = entry.id === model;
            return (
              <button
                key={entry.id}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={focusedIndex === index ? 0 : -1}
                onClick={() => select(entry.id)}
                onFocus={() => setFocusedIndex(index)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none ${active ? "bg-accent/60" : ""}`}
              >
                <span className="flex-1 truncate">{entry.id}</span>
                {isResponseVerifiableModel(entry.id) ? (
                  <ShieldCheckIcon aria-label="Response verified" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : isTeeCapableModel(entry.id) ? (
                  <ShieldIcon aria-label="TEE capable" className="size-3.5 text-muted-foreground" />
                ) : null}
                {typeof entry.multiplier === "number" ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary tabular-nums">
                    {Number.parseFloat(entry.multiplier.toFixed(1))}×
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">Rates unavailable</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {status && <div role="status" className="absolute left-0 top-full mt-0.5 whitespace-nowrap text-[10px] text-muted-foreground">{status}</div>}
    </div>
  );
}
