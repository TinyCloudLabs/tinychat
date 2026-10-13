import { useRef, type ReactNode, type Ref } from "react";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { DESKTOP_HOME_COPY } from "./desktopCopy";
import "./systemAudioStart.css";

/** Every Record trigger uses the provider's shared disclosure and start entry point. */
export function SystemAudioStart(props: { renderTrigger?: (onClick: () => void, disabled: boolean, ref: Ref<HTMLButtonElement>) => ReactNode }) {
  const recorder = useRecorder();
  const opener = useRef<HTMLButtonElement>(null);
  return props.renderTrigger
    ? props.renderTrigger(recorder.record, !recorder.ready, opener)
    : <button ref={opener} type="button" className="dch-start" onClick={recorder.record} disabled={!recorder.ready} aria-label={DESKTOP_HOME_COPY.startLabel} data-testid="voice-note-record">
        <i className="dch-dot" aria-hidden="true" />{DESKTOP_HOME_COPY.start}
      </button>;
}
