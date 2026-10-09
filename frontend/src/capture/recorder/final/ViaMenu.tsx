import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LevelBars } from "./halo";
import type { AudioInput } from "@/lib/voiceNotes/nativeVoiceNotes";
import {
  CheckIcon,
  ChevronDownIcon,
  HeadphonesIcon,
  MicIcon,
  ModeIcon,
} from "./softIcons";

function InputIcon({ kind }: { kind: AudioInput["kind"] }) {
  if (kind === "built_in") return <ModeIcon id="local" size={18} />;
  if (kind === "bluetooth" || kind === "car") return <HeadphonesIcon />;
  return <MicIcon />;
}

export interface ViaMenuProps {
  inputs: readonly AudioInput[];
  currentId: string | null;
  /** The name shown on the button. */
  currentName: string;
  recording: boolean;
  theme: "night" | "day";
  subscribeLevel: (listener: (level: number) => void) => () => void;
  /** A retry would fail without a good input: outline it. */
  emphasis: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  defaultOpen?: boolean;
}

export function ViaMenu({
  inputs,
  currentId,
  currentName,
  recording,
  theme,
  subscribeLevel,
  emphasis,
  disabled,
  onSelect,
  defaultOpen = false,
}: ViaMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    items.current[
      Math.max(
        0,
        inputs.findIndex((i) => i.id === currentId),
      )
    ]?.focus();
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, inputs, currentId]);

  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      close(true);
      return;
    }
    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const at = items.current.findIndex((el) => el === document.activeElement);
    items.current[
      Math.max(0, Math.min(inputs.length - 1, at + direction))
    ]?.focus();
  };

  return (
    <div ref={root} className="pr-src-wrap" onKeyDown={key}>
      {open && (
        <div
          className="pr-menu"
          role="menu"
          aria-label="Record from"
          data-testid="via-menu"
        >
          <div className="pr-menu-head" aria-hidden="true">
            Record from
          </div>
          {inputs.length === 0 && (
            <div className="pr-menu-note">No other inputs found</div>
          )}
          {inputs.map((input, i) => (
            <button
              key={input.id}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={input.id === currentId}
              className="pr-item"
              onClick={() => {
                onSelect(input.id);
                close(true);
              }}
            >
              <span className="label">
                <InputIcon kind={input.kind} />
                <span>{input.name}</span>
              </span>
              {input.id === currentId && (
                <span className="ok">
                  <CheckIcon size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        ref={button}
        type="button"
        className="pr-srcbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Record from ${currentName}`}
        data-emphasis={emphasis}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pr-srcpill">
          <span>via</span>
          <span className="pr-lvb">
            <LevelBars
              bars={3}
              theme={theme}
              paused={!recording}
              subscribe={subscribeLevel}
            />
          </span>
          <span className="name">{currentName}</span>
          <ChevronDownIcon size={12} />
        </span>
      </button>
    </div>
  );
}
