import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlatformContext } from "@/lib/platform";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../../RecorderProvider";
import {
  desktopRecorderFor,
  LazyDesktopRecorder,
  LoadBoundary,
  LoadFailed,
  type DesktopRecorderLoader,
} from "./LazyDesktopRecorder";

const recording: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  sheetOpen: true,
};

const within = (node: ReactElement, patch: Partial<RecorderValue> = recording) =>
  renderToStaticMarkup(
    <PlatformContext.Provider value="tauri">
      <StaticRecorderProvider value={patch}>{node}</StaticRecorderProvider>
    </PlatformContext.Provider>,
  );

const Loaded = () => <div data-testid="loaded-recorder">The ring view</div>;
const loads = (
  promise: Promise<unknown>,
): DesktopRecorderLoader => () =>
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
    expect(LoadBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const onRetry = () => {};
    const boundary = new LoadBoundary({
      layout: "desktop",
      onRetry,
      children: null,
    });
    expect(boundary.render()).toBeNull();
    boundary.state = { failed: true };
    const failed = boundary.render() as ReactElement<{
      onRetry: () => void;
    }>;
    expect(failed.type).toBe(LoadFailed);
    expect(failed.props.onRetry).toBe(onRetry);
  });
});
