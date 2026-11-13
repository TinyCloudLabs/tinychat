import { Component, lazy, Suspense, useContext, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { reloadExo } from "@/capture/recorder/final/LazyPhoneRecorder";
import { shellForPlatform } from "@/capture/recorder/final/shellCapabilities";
import { isChunkLoadError } from "@/capture/recorder/final/desktop/LazyDesktopRecorder";
import { PlatformContext } from "@/lib/platform";

// The shell's screens other than Feed are chunks of their own, so the entry chunk carries only what boot and Feed need
// (TC-2882). App starts loading them all once the signed-in shell is up; a screen whose chunk is already in renders at
// once, without suspending. The recorder's own path (RecorderProvider, the overlay and its lazy sheet) stays eager.

export type LazyTab<P> = ComponentType<P> & {
  /** Starts loading the chunk (once); the screen then renders without suspending. */
  preload: () => Promise<unknown>;
};

/** The failure view; reloading the app is the remedy when the browser may have kept the failed chunk URL. */
export function LoadFailed({ name, reload, onRetry }: { name: string; reload: boolean; onRetry: () => void }) {
  const recorder = useRecorder();
  const web = shellForPlatform(useContext(PlatformContext)) === "web";
  const [confirming, setConfirming] = useState(false);
  // A reload stops a web recording: ask first. A phone's or the desktop app's recording is native and keeps going.
  const asks = reload && web && recorder.phase !== "idle";
  const button = "min-h-11 underline";
  return (
    <div role="alert" className="flex flex-col items-start gap-2 px-6 pt-6 text-callout text-destructive">
      <p className="m-0">Couldn’t open {name}.</p>
      {confirming ? (
        <>
          <p className="m-0">
            Reloading stops this recording in the browser. TinyCloud Home recovers what was recorded when the page
            reopens.
          </p>
          <button type="button" className={button} onClick={() => setConfirming(false)}>
            Keep recording
          </button>
          <button type="button" className={button} onClick={onRetry}>
            Reload
          </button>
        </>
      ) : (
        <button type="button" className={button} onClick={asks ? () => setConfirming(true) : onRetry}>
          {reload ? "Reload TinyCloud Home" : "Try again"}
        </button>
      )}
    </div>
  );
}

class LoadBoundary extends Component<
  {
    name: string;
    /** A retry has already failed once. */
    retried: boolean;
    onRetry: () => void;
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
    console.error(`[${this.props.name}] Could not load the screen`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // The browser may keep a failed module URL (and a deploy can remove it), so asking again for it won't help; only a
    // reload does.
    const reload = this.props.retried || isChunkLoadError(this.state.error);
    return <LoadFailed name={this.props.name} reload={reload} onRetry={reload ? this.props.reload : this.props.onRetry} />;
  }
}

/** A screen loaded from its own chunk. `name` is the screen's name in the load-failure message. */
export function lazyTab<P extends object>(
  name: string,
  load: () => Promise<ComponentType<P>>,
  reload: () => void = reloadExo,
): LazyTab<P> {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        // Dropped, so the next attempt fetches afresh.
        loading = undefined;
        throw error;
      },
    ));
  // React.lazy keeps a failed load, so each mount and each retry gets its own.
  const lazyComponent = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(() => preload().then((component) => ({ default: component })));

  function Tab(props: P) {
    // Fixed for this mount: switching between the lazy and the loaded component would remount the screen.
    const [Loaded] = useState(() => loaded);
    const [{ Lazy, attempt }, setLoad] = useState(() => ({ Lazy: lazyComponent(), attempt: 0 }));
    if (Loaded) return <Loaded {...props} />;
    return (
      <LoadBoundary
        key={attempt}
        name={name}
        retried={attempt > 0}
        reload={reload}
        onRetry={() => setLoad({ Lazy: lazyComponent(), attempt: attempt + 1 })}
      >
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      </LoadBoundary>
    );
  }
  Tab.displayName = `LazyTab(${name})`;
  return Object.assign(Tab, { preload });
}
