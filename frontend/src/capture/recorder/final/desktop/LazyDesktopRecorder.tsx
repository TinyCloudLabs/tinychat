import {
  Component,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  type RefObject,
} from "react";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder } from "../../RecorderProvider";
import { shellForPlatform, type RecorderLayout } from "../shellCapabilities";
import { ChevronDownIcon } from "../softIcons";
import { ConfirmDialog } from "./ConfirmDialog";
import type { DesktopRecorderProps } from "./DesktopRecorder";

// This file is in the main bundle; the recorder view it waits for is not, so nothing here may import its styles.

export type DesktopRecorderLoader = () => Promise<{
  DesktopRecorder: ComponentType<DesktopRecorderProps>;
}>;

export const importDesktopRecorder: DesktopRecorderLoader = () =>
  import("./DesktopRecorder");

type LazyRecorder = LazyExoticComponent<ComponentType<DesktopRecorderProps>>;
const components = new WeakMap<DesktopRecorderLoader, LazyRecorder>();
const loaded = new WeakSet<DesktopRecorderLoader>();

export const isDesktopRecorderLoaded = (load: DesktopRecorderLoader) =>
  loaded.has(load);

/** One lazy component per loader, so reopening the sheet doesn't suspend again; a failed load is dropped so the next render tries it afresh. */
export function desktopRecorderFor(load: DesktopRecorderLoader): LazyRecorder {
  const existing = components.get(load);
  if (existing) return existing;
  const component: LazyRecorder = lazy(() =>
    load().then(
      (module) => {
        loaded.add(load);
        return { default: module.DesktopRecorder };
      },
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

/** A module that could not be fetched: the browser may keep the failed URL, so asking again for it won't help; only a reload does. */
export function isChunkLoadError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
      message,
    )
  );
}

/** Vite fires this on window when any lazy chunk's preload fails; returns the unsubscribe. */
export function listenForPreloadError(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  onError: (event: Event) => void,
): () => void {
  target.addEventListener("vite:preloadError", onError);
  return () => target.removeEventListener("vite:preloadError", onError);
}

/** True when a `vite:preloadError` is this recorder's own load failing: it hasn't loaded yet, and the event's payload (an Error) doesn't name only other chunks. */
export function isDesktopRecorderPreloadError(
  load: DesktopRecorderLoader,
  event: Event,
): boolean {
  if (isDesktopRecorderLoaded(load)) return false;
  const payload = (event as Event & { payload?: unknown }).payload;
  const text =
    payload instanceof Error ? payload.message : String(payload ?? "");
  const urls = text.match(/[^\s"'()]+\.(?:js|css)\b/g);
  // URL-less failures are left to the recorder's own import and error boundary.
  return (
    urls !== null &&
    urls.some((url) => /(?:^|\/)DesktopRecorder-[\w-]+\.(?:js|css)$/.test(url))
  );
}

export const reloadExo = () => window.location.reload();

export function LoadFailed({
  layout,
  onRetry,
  needsReload = false,
  reload = reloadExo,
  defaultConfirming = false,
}: {
  layout: Exclude<RecorderLayout, "phone">;
  onRetry: () => void;
  /** Asking again can't help: offer Reload Exo instead of Try again. */
  needsReload?: boolean;
  reload?: () => void;
  defaultConfirming?: boolean;
}) {
  const recorder = useRecorder();
  const shell = shellForPlatform(useContext(PlatformContext));
  const [confirming, setConfirming] = useState(defaultConfirming);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const ids = useId();
  return LoadFailedView({
    layout,
    recording: recorder.phase !== "idle",
    web: shell === "web",
    needsReload,
    confirming,
    ids,
    reloadButton,
    onRetry,
    onAskReload: () => setConfirming(true),
    onKeep: () => setConfirming(false),
    reload,
  });
}

export function LoadFailedView({
  layout,
  recording,
  web,
  needsReload,
  confirming,
  ids,
  reloadButton,
  onRetry,
  onAskReload,
  onKeep,
  reload,
}: {
  layout: Exclude<RecorderLayout, "phone">;
  recording: boolean;
  web: boolean;
  needsReload: boolean;
  confirming: boolean;
  ids: string;
  reloadButton: RefObject<HTMLButtonElement | null>;
  onRetry: () => void;
  onAskReload: () => void;
  onKeep: () => void;
  reload: () => void;
}) {
  return (
    <RecorderSurface layout={layout}>
      <p role="alert" className="pr-alert" style={{ padding: 0 }}>
        Couldn't open the recorder.
        {recording && " Your recording continues."}
        {needsReload ? (
          <button
            ref={reloadButton}
            type="button"
            className="pr-retry"
            onClick={recording ? onAskReload : reload}
          >
            Reload Exo
          </button>
        ) : (
          <button type="button" className="pr-retry" onClick={onRetry}>
            Try again
          </button>
        )}
      </p>
      {confirming && (
        <ConfirmDialog
          titleId={`${ids}-rt`}
          descriptionId={`${ids}-rd`}
          title="Reload Exo?"
          description={
            web
              ? "Reloading stops this recording in the browser. Exo recovers what was recorded when the page reopens."
              : "The recording keeps going while Exo reloads."
          }
          keep={{ label: "Keep recording", onPress: onKeep }}
          other={{ label: "Reload", tone: "danger", onPress: reload }}
          returnFocus={reloadButton}
        />
      )}
    </RecorderSurface>
  );
}

export class LoadBoundary extends Component<
  {
    layout: Exclude<RecorderLayout, "phone">;
    onRetry: () => void;
    /** A retry has already failed once. */
    retried?: boolean;
    reload?: () => void;
    children: ReactNode;
  },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown) {
    console.error("[Recorder] Could not load the desktop recorder", error);
  }

  render() {
    return this.state.failed ? (
      <LoadFailed
        layout={this.props.layout}
        onRetry={this.props.onRetry}
        needsReload={
          this.props.retried === true || isChunkLoadError(this.state.error)
        }
        reload={this.props.reload}
      />
    ) : (
      this.props.children
    );
  }
}

export interface LazyDesktopRecorderProps extends DesktopRecorderProps {
  /** Where the view comes from; the dynamic import unless a test says otherwise. */
  load?: DesktopRecorderLoader;
  /** What Reload Exo does; reloads the page unless a test says otherwise. */
  reload?: () => void;
}

export function LazyDesktopRecorder({
  load = importDesktopRecorder,
  reload = reloadExo,
  ...props
}: LazyDesktopRecorderProps) {
  const [attempt, setAttempt] = useState(0);
  const [preloadFailed, setPreloadFailed] = useState(false);
  useEffect(
    () =>
      listenForPreloadError(window, (event) => {
        if (isDesktopRecorderPreloadError(load, event)) setPreloadFailed(true);
      }),
    [load],
  );
  const Recorder = desktopRecorderFor(load);
  if (preloadFailed)
    return (
      <LoadFailed
        layout={props.layout}
        onRetry={() => {}}
        needsReload
        reload={reload}
      />
    );
  return (
    <LoadBoundary
      key={attempt}
      layout={props.layout}
      retried={attempt > 0}
      reload={reload}
      onRetry={() => setAttempt((count) => count + 1)}
    >
      <Suspense fallback={<Opening layout={props.layout} />}>
        <Recorder {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
