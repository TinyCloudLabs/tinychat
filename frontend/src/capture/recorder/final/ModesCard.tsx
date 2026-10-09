import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { CloseIcon, CheckIcon, ModeIcon } from "./softIcons";
import { identifySpeakersControl, modeSubLabel, type ModeId, type ModeShell } from "./transcriptionModes";
import type { ScaleStop } from "./useTranscriptionChoice";

const DOTS = 4;

function Dots({ value, label }: { value: number; label: string }) {
  if (value <= 0) return <span className="pr-dots-col" role="img" aria-label={`${label}: none`}><span className="none">—</span></span>;
  const shown = Math.min(DOTS, value);
  return (
    <span className="pr-dots-col" role="img" aria-label={`${label}: ${shown} of ${DOTS}`}>
      {Array.from({ length: DOTS }, (_, i) => <i key={i} className={i < shown ? "on" : undefined} />)}
    </span>
  );
}

export interface ModesCardProps {
  stops: readonly ScaleStop[];
  mode: ModeId;
  shell: ModeShell;
  identifySpeakers: boolean;
  onChoose: (id: ModeId) => void;
  onToggleSpeakers: (enabled: boolean) => void;
  onClose: () => void;
  /** The ⓘ⌄ button, which a click on it does not count as outside. */
  opener: RefObject<HTMLElement | null>;
}

export function ModesCard({ stops, mode, shell, identifySpeakers, onChoose, onToggleSpeakers, onClose, opener }: ModesCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<ModeId, HTMLButtonElement>());
  const speakers = identifySpeakersControl(mode, identifySpeakers);

  useEffect(() => {
    rows.current.get(mode)?.focus();
  }, [mode]);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !opener.current?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose, opener]);

  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const ids = stops.filter((s) => s.available).map((s) => s.stop.id);
    const focused = [...rows.current].find(([, el]) => el === document.activeElement)?.[0] ?? mode;
    const at = ids.indexOf(focused);
    const next = ids[Math.max(0, Math.min(ids.length - 1, at + direction))];
    if (next) rows.current.get(next)?.focus();
  };

  return (
    <div ref={root} className="pr-modes" data-testid="modes-card" onKeyDown={key}>
      <div className="pr-mphead">
        <span>More private → more capable</span>
        <button type="button" aria-label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="pr-mplg" aria-hidden="true">
        <span>Privacy</span>
        <span>Accuracy</span>
      </div>
      <div role="radiogroup" aria-label="Transcription mode">
        {stops.map(({ stop, available, reason }) => {
          const checked = stop.id === mode;
          return (
            <button
              key={stop.id}
              ref={(el) => {
                if (el) rows.current.set(stop.id, el);
                else rows.current.delete(stop.id);
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={!available}
              tabIndex={checked ? 0 : -1}
              className="pr-mprow"
              data-mode={stop.id}
              onClick={() => onChoose(stop.id)}
            >
              <span className="pr-tile"><ModeIcon id={stop.id} size={14} /></span>
              <span className="pr-mptitle">
                <span className="n soft-title">{stop.shortName}</span>
                <span className="s">{modeSubLabel(stop.id, shell)}</span>
                {checked && <CheckIcon size={13} />}
              </span>
              <span className="pr-mpdots">
                <Dots value={stop.privacyDots} label="Privacy" />
                <Dots value={stop.accuracyDots} label="Accuracy" />
              </span>
              <span className="pr-mpbody">
                {stop.explanations[shell]}
                {!available && reason ? <><br />{reason}</> : null}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={speakers.checked}
        aria-disabled={speakers.disabled}
        className="pr-spk"
        onClick={() => !speakers.disabled && onToggleSpeakers(!speakers.checked)}
      >
        <span className="t">
          <span className="l">{speakers.label}</span>
          <br />
          <span className="s">{speakers.subLabel}</span>
        </span>
        <span className="pr-sw" aria-hidden="true" />
      </button>
    </div>
  );
}
