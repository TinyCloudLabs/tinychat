import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import type { SavedNoteProps } from "./SavedNote";

// The saved note's page and sheet are a chunk of their own: nothing here may import their styles or editor.
const SavedNote = lazy(() => import("./SavedNote"));

class LoadBoundary extends Component<
  { onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[SavedNote] Could not load the note view", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p role="alert" className="px-6 pt-6 text-callout text-destructive">
        Couldn’t open the note.{" "}
        <button type="button" className="underline" onClick={this.props.onRetry}>
          Try again
        </button>
      </p>
    );
  }
}

export function LazySavedNote(props: SavedNoteProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <LoadBoundary key={attempt} onRetry={() => setAttempt((n) => n + 1)}>
      <Suspense
        fallback={
          <p role="status" className="px-6 pt-6 text-callout text-muted-foreground">
            Opening the note…
          </p>
        }
      >
        <SavedNote {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
