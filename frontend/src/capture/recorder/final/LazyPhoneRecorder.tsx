import {
  Component,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { PlatformContext } from "@/lib/platform";
import { useRecorder } from "../RecorderProvider";
import { shellForPlatform } from "./shellCapabilities";
import { ChevronDownIcon } from "./softIcons";
import { isChunkLoadError } from "./desktop/LazyDesktopRecorder";
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

export function SurfaceView({
  onMinimise,
  children,
}: {
  onMinimise: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="phone-recorder-surface"
      className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted-foreground"
    >
      <button
        type="button"
        aria-label="Minimise recorder"
        className="absolute left-3 top-[calc(env(safe-area-inset-top)+0.5rem)] flex size-11 items-center justify-center rounded-full text-foreground"
        onClick={onMinimise}
      >
        <ChevronDownIcon size={19} />
      </button>
      {children}
    </div>
  );
}

/** The recorder's stand-in while it loads or can't: it always offers Minimise, so a stalled or failed chunk never traps a recording. */
export function Surface({ children }: { children: ReactNode }) {
  const recorder = useRecorder();
  return (
    <SurfaceView onMinimise={() => void recorder.minimiseSheet()}>
      {children}
    </SurfaceView>
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

/** True when a `vite:preloadError` is this recorder's own chunk failing: it hasn't loaded yet, and the event's payload doesn't name only other chunks. */
export function isPhoneRecorderPreloadError(event: Event): boolean {
  const payload = (event as Event & { payload?: unknown }).payload;
  const text =
    payload instanceof Error ? payload.message : String(payload ?? "");
  const urls = text.match(/[^\s"'()]+\.(?:js|css)\b/g);
  // URL-less failures are left to the recorder's own import and error boundary.
  return (
    urls !== null &&
    urls.some((url) => /(?:^|\/)PhoneRecorder-[\w-]+\.(?:js|css)$/.test(url))
  );
}

export const reloadExo = () => window.location.reload();

export function LoadFailed({
  onRetry,
  label = "Try again",
  defaultConfirming = false,
}: {
  onRetry: () => void;
  label?: string;
  defaultConfirming?: boolean;
}) {
  const recorder = useRecorder();
  const web = shellForPlatform(useContext(PlatformContext)) === "web";
  const recording = recorder.phase !== "idle";
  const [confirming, setConfirming] = useState(defaultConfirming);
  // Reload Exo while a web recording runs would stop it: ask first. A phone's recording is native and keeps going.
  const asks = label === "Reload Exo" && recording && web;
  return (
    <Surface>
      <p role="alert" className="m-0">
        Couldn't open the recorder.
        {recording && " Your recording continues."}
      </p>
      {confirming && asks ? (
        <>
          <p className="m-0">
            Reloading stops this recording in the browser. Exo recovers what was
            recorded when the page reopens.
          </p>
          <button
            type="button"
            className="min-h-11 px-3 font-semibold text-foreground underline"
            onClick={() => setConfirming(false)}
          >
            Keep recording
          </button>
          <button
            type="button"
            className="min-h-11 px-3 font-semibold text-destructive underline"
            onClick={onRetry}
          >
            Reload
          </button>
        </>
      ) : (
        <button
          type="button"
          className="min-h-11 px-3 font-semibold text-foreground underline"
          onClick={asks ? () => setConfirming(true) : onRetry}
        >
          {label}
        </button>
      )}
    </Surface>
  );
}

class LoadBoundary extends Component<
  {
    onRetry: () => void;
    /** A retry has already failed once. */
    retried: boolean;
    reload: () => void;
    children: ReactNode;
  },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown) {
    console.error("[Recorder] Could not load the phone recorder", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // The browser may keep a failed URL, so asking again for it won't help; only a reload does.
    return this.props.retried || isChunkLoadError(this.state.error) ? (
      <LoadFailed label="Reload Exo" onRetry={this.props.reload} />
    ) : (
      <LoadFailed onRetry={this.props.onRetry} />
    );
  }
}

export interface LazyPhoneRecorderProps extends PhoneRecorderProps {
  /** Where the view comes from; the dynamic import unless a test says otherwise. */
  load?: PhoneRecorderLoader;
  /** What Reload Exo does; reloads the page unless a test says otherwise. */
  reload?: () => void;
}

/** The final phone recorder, fetched when it is first shown (never with the flag off, which never renders it). */
export function LazyPhoneRecorder({
  load = importPhoneRecorder,
  reload = reloadExo,
  ...props
}: LazyPhoneRecorderProps) {
  const [attempt, setAttempt] = useState(0);
  const [preloadFailed, setPreloadFailed] = useState(false);
  useEffect(() => {
    const onError = (event: Event) => {
      if (isPhoneRecorderPreloadError(event)) setPreloadFailed(true);
    };
    window.addEventListener("vite:preloadError", onError);
    return () => window.removeEventListener("vite:preloadError", onError);
  }, []);
  const Recorder = phoneRecorderFor(load);
  if (preloadFailed)
    return (
      <LoadFailed label="Reload Exo" onRetry={reload} />
    );
  return (
    <LoadBoundary
      key={attempt}
      retried={attempt > 0}
      reload={reload}
      onRetry={() => setAttempt((count) => count + 1)}
    >
      <Suspense fallback={<Opening />}>
        <Recorder {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
