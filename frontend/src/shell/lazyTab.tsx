import { Component, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";

// The shell's screens other than Feed are chunks of their own, so the entry chunk carries only what boot and Feed need
// (TC-2882). App starts loading them all once the signed-in shell is up; a screen whose chunk is already in renders at
// once, without suspending. The recorder's own path (RecorderProvider, the overlay and its lazy sheet) stays eager.

export type LazyTab<P> = ComponentType<P> & {
  /** Starts loading the chunk (once); the screen then renders without suspending. */
  preload: () => Promise<unknown>;
};

class LoadBoundary extends Component<
  { name: string; onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[${this.props.name}] Could not load the screen`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p role="alert" className="px-6 pt-6 text-callout text-destructive">
        Couldn’t open {this.props.name}.{" "}
        <button type="button" className="underline" onClick={this.props.onRetry}>
          Try again
        </button>
      </p>
    );
  }
}

/** A screen loaded from its own chunk. `name` is the screen's name in the load-failure message. */
export function lazyTab<P extends object>(name: string, load: () => Promise<ComponentType<P>>): LazyTab<P> {
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
  const lazyComponent = () => lazy(() => preload().then((component) => ({ default: component })));
  // React.lazy keeps a failed load: a retry needs a new one.
  let Lazy: LazyExoticComponent<ComponentType<P>> = lazyComponent();

  function Tab(props: P) {
    // Fixed for this mount: switching between the lazy and the loaded component would remount the screen.
    const [Loaded] = useState(() => loaded);
    const [attempt, setAttempt] = useState(0);
    if (Loaded) return <Loaded {...props} />;
    return (
      <LoadBoundary
        key={attempt}
        name={name}
        onRetry={() => {
          Lazy = lazyComponent();
          setAttempt((n) => n + 1);
        }}
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
