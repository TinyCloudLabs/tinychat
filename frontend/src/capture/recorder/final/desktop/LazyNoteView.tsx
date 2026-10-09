import { lazy, Suspense, useState, type ComponentType } from "react";
import type { NoteViewProps } from "./NoteView";
import { LoadBoundary, RecorderSurface } from "./LazyDesktopRecorder";

// This file is in the main bundle; the note view is not, so nothing here may import its styles.

export type NoteViewLoader = () => Promise<{
  NoteView: ComponentType<NoteViewProps>;
}>;

export const importNoteView: NoteViewLoader = () => import("./NoteView");

const components = new WeakMap<
  NoteViewLoader,
  ReturnType<typeof lazy<ComponentType<NoteViewProps>>>
>();

function noteViewFor(load: NoteViewLoader) {
  const existing = components.get(load);
  if (existing) return existing;
  const component = lazy(() =>
    load().then(
      (module) => ({ default: module.NoteView }),
      (error: unknown) => {
        if (components.get(load) === component) components.delete(load);
        throw error;
      },
    ),
  );
  components.set(load, component);
  return component;
}

export function LazyNoteView({
  load = importNoteView,
  ...props
}: NoteViewProps & { load?: NoteViewLoader }) {
  const [attempt, setAttempt] = useState(0);
  const View = noteViewFor(load);
  return (
    <LoadBoundary
      key={attempt}
      layout={props.layout}
      retried={attempt > 0}
      onRetry={() => setAttempt((count) => count + 1)}
    >
      <Suspense
        fallback={
          <RecorderSurface layout={props.layout}>
            <p role="status" style={{ margin: 0 }}>
              Opening notes…
            </p>
          </RecorderSurface>
        }
      >
        <View {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
