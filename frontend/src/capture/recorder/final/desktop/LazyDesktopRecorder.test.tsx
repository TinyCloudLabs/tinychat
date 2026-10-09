import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlatformContext, type AppPlatform } from "@/lib/platform";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../../RecorderProvider";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  desktopRecorderFor,
  isChunkLoadError,
  LazyDesktopRecorder,
  listenForPreloadError,
  LoadBoundary,
  LoadFailed,
  LoadFailedView,
  type DesktopRecorderLoader,
} from "./LazyDesktopRecorder";

const recording: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  sheetOpen: true,
};

const within = (
  node: ReactElement,
  patch: Partial<RecorderValue> = recording,
  platform: AppPlatform = "tauri",
) =>
  renderToStaticMarkup(
    <PlatformContext.Provider value={platform}>
      <StaticRecorderProvider value={patch}>{node}</StaticRecorderProvider>
    </PlatformContext.Provider>,
  );

const Loaded = () => <div data-testid="loaded-recorder">The ring view</div>;
const loads =
  (promise: Promise<unknown>): DesktopRecorderLoader =>
  () =>
    promise.then(() => ({ DesktopRecorder: Loaded }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LazyDesktopRecorder", () => {
  test("while the import is delayed, a labelled Recorder surface says it is opening, and it can be minimised", () => {
    const load = loads(new Promise(() => {}));
    const html = within(<LazyDesktopRecorder layout="desktop" load={load} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Recorder"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Opening recorder…");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Minimise recorder"');
    expect(html).toContain("soft-skin soft-day pr");
    expect(html).toContain('data-layout="desktop"');
    expect(html).not.toContain("loaded-recorder");
  });

  test("once the import resolves, the loaded view replaces the surface, and reopening does not suspend again", async () => {
    const load = loads(Promise.resolve());
    const node = <LazyDesktopRecorder layout="rail" load={load} />;
    expect(within(node)).toContain("Opening recorder…");
    await settle();
    const html = within(node);
    expect(html).toContain("loaded-recorder");
    expect(html).not.toContain("Opening recorder…");
  });

  test("a rejected import is dropped, so the next attempt imports again and succeeds", async () => {
    let calls = 0;
    const load: DesktopRecorderLoader = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("chunk 404"))
        : Promise.resolve({ DesktopRecorder: Loaded });
    };
    const first = desktopRecorderFor(load);
    expect(desktopRecorderFor(load)).toBe(first);
    const node = <LazyDesktopRecorder layout="desktop" load={load} />;
    within(node);
    await settle();
    expect(calls).toBe(1);
    expect(desktopRecorderFor(load)).not.toBe(first);
    expect(within(node)).toContain("Opening recorder…");
    await settle();
    expect(calls).toBe(2);
    expect(within(node)).toContain("loaded-recorder");
  });
});

describe("LoadFailed", () => {
  test("says the recorder could not open, offers Try again, and says the recording continues", () => {
    const html = within(<LoadFailed layout="desktop" onRetry={() => {}} />);
    expect(html).toContain("Couldn&#x27;t open the recorder.");
    expect(html).toContain("Your recording continues.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).toContain('aria-label="Recorder"');
    expect(html).toContain('aria-label="Minimise recorder"');
  });

  test("does not claim a recording when none is running", () => {
    const html = within(<LoadFailed layout="desktop" onRetry={() => {}} />, {
      phase: "idle",
    });
    expect(html).toContain("Try again");
    expect(html).not.toContain("recording continues");
  });
});

describe("LoadBoundary", () => {
  test("a throw from the import puts up the failed surface, and Try again is its retry", () => {
    const error = new Error("boom");
    expect(LoadBoundary.getDerivedStateFromError(error)).toEqual({
      failed: true,
      error,
    });
    const onRetry = () => {};
    const boundary = new LoadBoundary({
      layout: "desktop",
      onRetry,
      children: null,
    });
    expect(boundary.render()).toBeNull();
    boundary.state = { failed: true, error: new Error("boom") };
    const failed = boundary.render() as ReactElement<{
      onRetry: () => void;
    }>;
    expect(failed.type).toBe(LoadFailed);
    expect(failed.props.onRetry).toBe(onRetry);
  });
});

const chunkError = new TypeError(
  "Failed to fetch dynamically imported module: https://exo.test/assets/DesktopRecorder-abc.js",
);

function failedElement(props: { retried?: boolean; error: unknown }) {
  const boundary = new LoadBoundary({
    layout: "desktop",
    onRetry: () => {},
    retried: props.retried,
    children: null,
  });
  boundary.state = { failed: true, error: props.error };
  return boundary.render() as ReactElement<{ needsReload: boolean }>;
}

function find(
  node: ReactNode,
  match: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, any>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, any>>(node)) return null;
  return match(node) ? node : find(node.props.children, match);
}

const view = (patch: Partial<Parameters<typeof LoadFailedView>[0]>) =>
  LoadFailedView({
    layout: "desktop",
    recording: false,
    web: false,
    needsReload: true,
    confirming: false,
    ids: "r",
    reloadButton: { current: null },
    onRetry: () => {},
    onAskReload: () => {},
    onKeep: () => {},
    reload: () => {},
    ...patch,
  });
const button = (tree: ReactElement, label: string) =>
  find(tree, (e) => e.type === "button" && e.props.children === label);

describe("isChunkLoadError", () => {
  test("recognises the browsers' dynamic-import failures and ChunkLoadError, and nothing else", () => {
    expect(isChunkLoadError(chunkError)).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("error loading dynamically imported module: x.js"),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    const named = new Error("Loading chunk 7 failed.");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("x is not a function"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("Reload Exo", () => {
  test("a chunk-load error goes straight to Reload Exo, with no Try again", () => {
    expect(failedElement({ error: chunkError }).props.needsReload).toBe(true);
    const html = within(
      <LoadFailed layout="desktop" onRetry={() => {}} needsReload />,
    );
    expect(html).toContain("Reload Exo");
    expect(html).not.toContain("Try again");
  });

  test("another error offers Try again first, and Reload Exo once the retry has failed too", () => {
    const other = new Error("render blew up");
    expect(failedElement({ error: other }).props.needsReload).toBe(false);
    expect(
      failedElement({ error: other, retried: true }).props.needsReload,
    ).toBe(true);
    const first = within(<LoadFailed layout="desktop" onRetry={() => {}} />);
    expect(first).toContain("Try again");
    expect(first).not.toContain("Reload Exo");
  });

  test("with no recording, Reload Exo calls the reload seam directly", () => {
    let reloads = 0;
    const tree = view({ reload: () => (reloads += 1) });
    expect(find(tree, (e) => e.type === ConfirmDialog)).toBeNull();
    button(tree, "Reload Exo")?.props.onClick();
    expect(reloads).toBe(1);
  });

  test("with a recording, Reload Exo asks first, and only Reload calls the seam", () => {
    let reloads = 0;
    let asked = 0;
    let kept = 0;
    const handlers = {
      recording: true,
      reload: () => (reloads += 1),
      onAskReload: () => (asked += 1),
      onKeep: () => (kept += 1),
    };
    button(view(handlers), "Reload Exo")?.props.onClick();
    expect([asked, reloads]).toEqual([1, 0]);

    const dialog = find(
      view({ ...handlers, confirming: true }),
      (e) => e.type === ConfirmDialog,
    );
    expect(dialog?.props.keep.label).toBe("Keep recording");
    expect(dialog?.props.other).toMatchObject({
      label: "Reload",
      tone: "danger",
    });
    expect(dialog?.props.role ?? "alertdialog").toBe("alertdialog");
    dialog?.props.keep.onPress();
    expect([kept, reloads]).toEqual([1, 0]);
    dialog?.props.other.onPress();
    expect(reloads).toBe(1);
  });

  test("the confirm is an alertdialog with Keep recording focused and Reload in red, honest per shell", () => {
    const confirm = (platform: AppPlatform) =>
      within(
        <LoadFailed
          layout="desktop"
          onRetry={() => {}}
          needsReload
          defaultConfirming
        />,
        recording,
        platform,
      );
    const web = confirm("web");
    expect(web).toContain('role="alertdialog"');
    expect(web).toMatch(
      /<button[^>]*pr-keep[^>]*data-initial=""[^>]*>Keep recording</,
    );
    expect(web).toContain("pr-discard");
    expect(web).toContain(
      "Reloading stops this recording in the browser. Exo recovers what was recorded when the page reopens.",
    );
    for (const platform of ["tauri", "ios", "android"] as const) {
      const html = confirm(platform);
      expect(html).toContain("The recording keeps going while Exo reloads.");
      expect(html).not.toContain("stops this recording");
    }
  });
});

describe("vite:preloadError", () => {
  test("is listened for on window until unsubscribed, and routes to the handler", () => {
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, fn: () => void) =>
        listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    let failures = 0;
    const stop = listenForPreloadError(
      target as unknown as Window,
      () => (failures += 1),
    );
    listeners.get("vite:preloadError")?.();
    expect(failures).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});
