import { Component, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

// The last line of defence: a render error nothing below caught would otherwise
// unmount the whole tree and leave a blank root. Reloading keeps the address, so
// the router lands the user back on the screen they were on.
export class RootErrorBoundary extends Component<
  { children: ReactNode; onReload?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[App] Render error reached the root", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="grid h-dvh place-items-center overflow-y-auto p-6">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-5 text-center">
          <img src="/icons/pwa-192.png" alt="" className="size-12 rounded-2xl" />
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-title-2">Exo hit a snag</h1>
            <p className="text-callout text-muted-foreground">
              Reload to pick up where you left off. Your notes are safe.
            </p>
          </div>
          <Button onClick={this.props.onReload ?? (() => window.location.reload())} className="h-11 px-6 fine:h-9 fine:px-4">
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
