import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useRecorder, type RecorderValue } from "../RecorderProvider";
import { useRecordedElapsed } from "../useRecordedElapsed";
import { minimizedView } from "./minimizedView";
import { useSilencedSince } from "./useSilencedSince";

type Control = "pause" | "resume" | "stop";

export interface CaptureDotState {
  kind: "live" | "paused" | "hollow";
  /** The recorder's state in words, for the Capture item's accessible name. */
  status: string;
}

interface MinimizedValue {
  elapsedMs: number;
  /** When this view first saw the mic silenced; null while it is not. */
  silencedSinceMs: number | null;
  /** Runs a recorder control and remembers which, so a rejection can be logged by name. */
  control: (name: Control) => void;
  captureDot: CaptureDotState | null;
  /** How many Ribbon/dock controls are on screen; a swap between them is not an entrance. */
  controls: MutableRefObject<number>;
  /** Counts the times the user minimised a live recording (the sheet went from open to closed). */
  minimizedCount: number;
}

const MinimizedContext = createContext<MinimizedValue | null>(null);

/**
 * Holds the recorded-time clock above the Ribbon/dock swap, so crossing a
 * breakpoint remounts the control but never rewinds the timer to the last
 * native checkpoint.
 */
export function MinimizedProvider({ children }: { children: ReactNode }) {
  const recorder = useRecorder();
  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  const controls = useRef(0);
  const active =
    recorder.phase === "starting" || recorder.phase === "recording";
  const silencedSinceMs = useSilencedSince(
    recorder.phase === "recording" && recorder.mic.state === "silenced",
  );
  // The controller reports a rejected Pause, Resume or Stop only as `recorder.error`. The open sheet logs its own.
  const lastControl = useRef<Control | null>(null);
  const control = (name: Control) => {
    lastControl.current = name;
    recorder[name]();
  };
  useEffect(() => {
    if (!recorder.error || recorder.sheetOpen) return;
    console.error(
      `[Recorder] ${lastControl.current ? `${lastControl.current} failed` : "Recorder error"}`,
      { error: recorder.error, phase: recorder.phase, mic: recorder.mic },
    );
    lastControl.current = null;
  }, [recorder.error]);
  const sheetWasOpen = useRef(recorder.sheetOpen);
  const [minimizedCount, setMinimizedCount] = useState(0);
  useEffect(() => {
    if (sheetWasOpen.current && !recorder.sheetOpen && active)
      setMinimizedCount((count) => count + 1);
    sheetWasOpen.current = recorder.sheetOpen;
  }, [recorder.sheetOpen, active]);
  let captureDot: CaptureDotState | null = null;
  if (active) {
    const view = minimizedView(recorder, elapsedMs, silencedSinceMs);
    const { dot } = view.pill;
    captureDot = {
      kind:
        dot === "red" ? "live" : dot === "filled-grey" ? "paused" : "hollow",
      status: view.status,
    };
  }
  return (
    <MinimizedContext.Provider
      value={{
        elapsedMs,
        silencedSinceMs,
        control,
        captureDot,
        controls,
        minimizedCount,
      }}
    >
      {children}
    </MinimizedContext.Provider>
  );
}

export function useMinimizedElapsed(): number {
  const value = useContext(MinimizedContext);
  if (value === null)
    throw new Error("useMinimizedElapsed needs a MinimizedProvider");
  return value.elapsedMs;
}

export function useMinimizedSilencedSince(): number | null {
  const value = useContext(MinimizedContext);
  if (value === null)
    throw new Error("useMinimizedSilencedSince needs a MinimizedProvider");
  return value.silencedSinceMs;
}

/** The recorder with Pause, Resume and Stop routed through the provider, which names the one that fails. */
export function useMinimizedRecorder(): RecorderValue {
  const recorder = useRecorder();
  const value = useContext(MinimizedContext);
  if (value === null)
    throw new Error("useMinimizedRecorder needs a MinimizedProvider");
  const { control } = value;
  return {
    ...recorder,
    pause: () => control("pause"),
    resume: () => control("resume"),
    stop: () => control("stop"),
  };
}

/** The Capture item's dot; null outside the final recorder, so the sidebar is untouched. */
export function useCaptureDot(): CaptureDotState | null {
  return useContext(MinimizedContext)?.captureDot ?? null;
}

/** True when this control appears with no other on screen: only then does it animate in. */
export function useEntrance(): boolean {
  const value = useContext(MinimizedContext);
  if (value === null) throw new Error("useEntrance needs a MinimizedProvider");
  const { controls } = value;
  const [entering] = useState(() => controls.current === 0);
  useEffect(() => {
    controls.current += 1;
    return () => {
      controls.current -= 1;
    };
  }, [controls]);
  return entering;
}

const ANNOUNCEMENT_MS = 2000;

/**
 * "Minimized", once, from the control that appears because the user minimised:
 * not on first mount, and not from the control that replaces it when a
 * breakpoint is crossed.
 */
export function useMinimizedAnnouncement(entering: boolean): string {
  const value = useContext(MinimizedContext);
  if (value === null)
    throw new Error("useMinimizedAnnouncement needs a MinimizedProvider");
  const { minimizedCount } = value;
  const seen = useRef(minimizedCount);
  const [text, setText] = useState("");
  useEffect(() => {
    if (minimizedCount === seen.current) return;
    seen.current = minimizedCount;
    if (!entering) return;
    setText("Minimized");
    const timer = setTimeout(() => setText(""), ANNOUNCEMENT_MS);
    return () => clearTimeout(timer);
  }, [minimizedCount, entering]);
  return text;
}
