import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder } from "../../RecorderProvider";
import type { RecorderLayout } from "../shellCapabilities";
import { ChevronDownIcon } from "../softIcons";
import type { DesktopRecorderProps } from "./DesktopRecorder";

// This file is in the main bundle; the recorder view it waits for is not, so nothing here may import its styles.

export type DesktopRecorderLoader = () => Promise<{
  DesktopRecorder: ComponentType<DesktopRecorderProps>;
}>;

export const importDesktopRecorder: DesktopRecorderLoader = () =>
  import("./DesktopRecorder");

type LazyRecorder = LazyExoticComponent<ComponentType<DesktopRecorderProps>>;
const components = new WeakMap<DesktopRecorderLoader, LazyRecorder>();

/** One lazy component per loader, so reopening the sheet doesn't suspend again; a failed load is dropped so the next render tries it afresh. */
export function desktopRecorderFor(load: DesktopRecorderLoader): LazyRecorder {
  const existing = components.get(load);
  if (existing) return existing;
  const component: LazyRecorder = lazy(() =>
    load().then(
      (module) => ({ default: module.DesktopRecorder }),
      (error: unknown) => {
        if (components.get(load) === component) components.delete(load);
        throw error;
      },
    ),
  );
  components.set(load, component);
  return component;
}

/** The recorder's own surface, labelled and focused, in the view's place until it is there (and while it can't be). */
export function RecorderSurface({
  layout,
  children,
}: {
  layout: Exclude<RecorderLayout, "phone">;
  children: ReactNode;
}) {
  const recorder = useRecorder();
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  return (
    <div
      ref={root}
      role="region"
      aria-label="Recorder"
      tabIndex={-1}
      className={`soft-skin soft-${theme} pr`}
      data-layout={layout}
      data-testid="desktop-recorder-surface"
      style={{
        position: "absolute",
        padding: "22px 40px 24px",
        outline: "none",
      }}
    >
      <div className="pr-top" style={{ margin: 0, padding: 0 }}>
        <button
          type="button"
          className="pr-ibtn"
          style={{ left: 0 }}
          aria-label="Minimise recorder"
          onClick={() => void recorder.minimiseSheet()}
        >
          <ChevronDownIcon size={19} />
        </button>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "var(--dim)",
          fontSize: 14,
          textAlign: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Opening({ layout }: { layout: Exclude<RecorderLayout, "phone"> }) {
  return (
    <RecorderSurface layout={layout}>
      <p role="status" style={{ margin: 0 }}>
        Opening recorder…
      </p>
    </RecorderSurface>
  );
}

export function LoadFailed({
  layout,
  onRetry,
}: {
  layout: Exclude<RecorderLayout, "phone">;
  onRetry: () => void;
}) {
  const recorder = useRecorder();
  return (
    <RecorderSurface layout={layout}>
      <p role="alert" className="pr-alert" style={{ padding: 0 }}>
        Couldn't open the recorder.
        {recorder.phase !== "idle" && " Your recording continues."}
        <button type="button" className="pr-retry" onClick={onRetry}>
          Try again
        </button>
      </p>
    </RecorderSurface>
  );
}

export class LoadBoundary extends Component<
  {
    layout: Exclude<RecorderLayout, "phone">;
    onRetry: () => void;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Recorder] Could not load the desktop recorder", error);
  }

  render() {
    return this.state.failed ? (
      <LoadFailed layout={this.props.layout} onRetry={this.props.onRetry} />
    ) : (
      this.props.children
    );
  }
}

export interface LazyDesktopRecorderProps extends DesktopRecorderProps {
  /** Where the view comes from; the dynamic import unless a test says otherwise. */
  load?: DesktopRecorderLoader;
}

export function LazyDesktopRecorder({
  load = importDesktopRecorder,
  ...props
}: LazyDesktopRecorderProps) {
  const [attempt, setAttempt] = useState(0);
  const Recorder = desktopRecorderFor(load);
  return (
    <LoadBoundary
      key={attempt}
      layout={props.layout}
      onRetry={() => setAttempt((count) => count + 1)}
    >
      <Suspense fallback={<Opening layout={props.layout} />}>
        <Recorder {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
