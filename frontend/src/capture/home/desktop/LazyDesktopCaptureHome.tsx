// The desktop home is its own chunk, so a phone never loads it.
import { Component, lazy, Suspense, type ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import type { DesktopCaptureHomeProps } from "./DesktopCaptureHome";

const DesktopCaptureHome = lazy(() =>
  import("./DesktopCaptureHome").then((m) => ({
    default: m.DesktopCaptureHome,
  })),
);

const reloadExo = () => window.location.reload();

class LoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Capture] Could not load the desktop home", error);
  }

  render() {
    return this.state.failed ? (
      <div
        role="alert"
        className="px-6 pt-8 text-callout text-muted-foreground"
        data-testid="capture-home-load-failed"
      >
        <p>Couldn’t open Capture.</p>
        <button
          type="button"
          className="mt-2 font-medium text-primary"
          onClick={reloadExo}
        >
          Reload Exo
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function LazyDesktopCaptureHome(props: DesktopCaptureHomeProps) {
  return (
    <LoadBoundary>
      <Suspense
        fallback={
          <div role="status" className="px-8 pt-8">
            <span className="sr-only">Opening Capture…</span>
            <Skeleton shape="row" />
          </div>
        }
      >
        <DesktopCaptureHome {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
