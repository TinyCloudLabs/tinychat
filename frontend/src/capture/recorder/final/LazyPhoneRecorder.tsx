import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { useRecorder } from "../RecorderProvider";
import { useNotesLifecycle } from "./notes/notesLifecycle";
import type { PhoneRecorderProps } from "./PhoneRecorder";

// This file is in the main bundle. The recorder it waits for (its styles, the notes sheet, writer and renderer) is not,
// so nothing here may import them except as types.

export type PhoneRecorderLoader = () => Promise<{
  PhoneRecorder: ComponentType<PhoneRecorderProps>;
}>;

export const importPhoneRecorder: PhoneRecorderLoader = () =>
  import("./PhoneRecorder");

type LazyRecorder = LazyExoticComponent<ComponentType<PhoneRecorderProps>>;
const components = new WeakMap<PhoneRecorderLoader, LazyRecorder>();

/** One lazy component per loader, so reopening the recorder doesn't suspend again; a failed load is dropped so the next render tries it afresh. */
export function phoneRecorderFor(load: PhoneRecorderLoader): LazyRecorder {
  const existing = components.get(load);
  if (existing) return existing;
  const component: LazyRecorder = lazy(() =>
    load().then(
      (module) => ({ default: module.PhoneRecorder }),
      (error: unknown) => {
        if (components.get(load) === component) components.delete(load);
        throw error;
      },
    ),
  );
  components.set(load, component);
  return component;
}

function Surface({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="phone-recorder-surface"
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function Opening() {
  return (
    <Surface>
      <p role="status" className="m-0">
        Opening recorder…
      </p>
    </Surface>
  );
}

export function LoadFailed({
  onRetry,
  label = "Try again",
}: {
  onRetry: () => void;
  label?: string;
}) {
  const recorder = useRecorder();
  return (
    <Surface>
      <p role="alert" className="m-0">
        Couldn't open the recorder.
        {recorder.phase !== "idle" && " Your recording continues."}
      </p>
      <button
        type="button"
        className="min-h-11 px-3 font-semibold text-foreground underline"
        onClick={onRetry}
      >
        {label}
      </button>
    </Surface>
  );
}

class LoadBoundary extends Component<
  { onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Recorder] Could not load the phone recorder", error);
  }

  render() {
    return this.state.failed ? (
      <LoadFailed onRetry={this.props.onRetry} />
    ) : (
      this.props.children
    );
  }
}

export interface LazyPhoneRecorderProps extends PhoneRecorderProps {
  /** Where the view comes from; the dynamic import unless a test says otherwise. */
  load?: PhoneRecorderLoader;
}

/** The final phone recorder, fetched when it is first shown (never with the flag off, which never renders it). */
export function LazyPhoneRecorder({
  load = importPhoneRecorder,
  ...props
}: LazyPhoneRecorderProps) {
  useNotesLifecycle();
  const [attempt, setAttempt] = useState(0);
  const [preloadFailed, setPreloadFailed] = useState(false);
  useEffect(() => {
    const onError = () => setPreloadFailed(true);
    window.addEventListener("vite:preloadError", onError);
    return () => window.removeEventListener("vite:preloadError", onError);
  }, []);
  const Recorder = phoneRecorderFor(load);
  if (preloadFailed)
    return (
      <LoadFailed label="Reload Exo" onRetry={() => window.location.reload()} />
    );
  return (
    <LoadBoundary
      key={attempt}
      onRetry={() => setAttempt((count) => count + 1)}
    >
      <Suspense fallback={<Opening />}>
        <Recorder {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
