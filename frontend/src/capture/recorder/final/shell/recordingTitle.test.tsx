import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { PlatformContext } from "@/lib/platform";
import { StaticRecorderProvider, type RecorderValue } from "../../RecorderProvider";
import { fakeClock, installReactTestEnv, mount } from "./hookTestUtil";
import {
  createTitleController,
  documentTitleTarget,
  recordingTitle,
  tauriWindowTitleTarget,
  titleTargetFor,
  useRecordingTitle,
  type TitleTarget,
} from "./recordingTitle";

describe("recordingTitle", () => {
  test("recording, paused, and nothing else", () => {
    expect(recordingTitle("recording", "recording", 42_000)).toBe("● 0:42 · Exo");
    expect(recordingTitle("recording", "paused", 42_900)).toBe("❚❚ 0:42 · Exo");
    expect(recordingTitle("recording", "recording", 3_725_000)).toBe("● 1:02:05 · Exo");
    for (const phase of ["idle", "starting", "stopping", "saving", "discarding"] as const)
      expect(recordingTitle(phase, "recording", 42_000)).toBeNull();
  });

  test("the web writes the tab, the desktop app the window, the phone apps nothing", () => {
    expect(titleTargetFor("web")).toBe(documentTitleTarget);
    expect(titleTargetFor("tauri")).toBe(tauriWindowTitleTarget);
    expect(titleTargetFor("ios")).toBeNull();
    expect(titleTargetFor("android")).toBeNull();
  });
});

function memoryTarget(initial: string, options: { delayMs?: number } = {}) {
  const log: string[] = [];
  const target: TitleTarget & { title: string } = {
    title: initial,
    read: () => target.title,
    write: async (title) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      target.title = title;
      log.push(title);
    },
  };
  return { target, log };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("createTitleController", () => {
  test("restores exactly the title it replaced, and only once", async () => {
    const { target, log } = memoryTarget("TinyCloud Chat");
    const controller = createTitleController(target);
    controller.apply("● 0:01 · Exo");
    controller.apply("● 0:02 · Exo");
    controller.apply(null);
    controller.apply(null);
    await settle();
    expect(log).toEqual(["● 0:01 · Exo", "● 0:02 · Exo", "TinyCloud Chat"]);
    expect(target.title).toBe("TinyCloud Chat");
  });

  test("does not restore a title it never replaced", async () => {
    const { target, log } = memoryTarget("TinyCloud Chat");
    createTitleController(target).apply(null);
    await settle();
    expect(log).toEqual([]);
  });

  test("a slow call cannot overtake a later one", async () => {
    const { target, log } = memoryTarget("Before", { delayMs: 5 });
    const controller = createTitleController(target);
    for (const second of [1, 2, 3]) controller.apply(`● 0:0${second} · Exo`);
    controller.apply(null);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(log).toEqual(["● 0:01 · Exo", "● 0:02 · Exo", "● 0:03 · Exo", "Before"]);
  });

  test("a failed read or write is reported, not swallowed, and later calls still run", async () => {
    const errors: unknown[] = [];
    const boom = new Error("window gone");
    let failing = true;
    const written: string[] = [];
    const target: TitleTarget = {
      read: () => "Before",
      write: async (title) => {
        if (failing) throw boom;
        written.push(title);
      },
    };
    const controller = createTitleController(target, (caught) => errors.push(caught));
    controller.apply("● 0:01 · Exo");
    await settle();
    expect(errors).toEqual([boom]);
    failing = false;
    controller.apply("● 0:02 · Exo");
    controller.apply(null);
    await settle();
    expect(written).toEqual(["● 0:02 · Exo", "Before"]);

    const readFails = createTitleController(
      { read: () => Promise.reject(boom), write: () => { throw new Error("must not write"); } },
      (caught) => errors.push(caught),
    );
    readFails.apply("● 0:01 · Exo");
    await settle();
    expect(errors).toEqual([boom, boom]);
  });

  test("the default failure report is a console.error", async () => {
    const original = console.error;
    const error = mock();
    console.error = error;
    try {
      createTitleController({ read: () => "x", write: () => Promise.reject(new Error("no")) }).apply("● 0:01 · Exo");
      await settle();
    } finally {
      console.error = original;
    }
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("tauriWindowTitleTarget", () => {
  test("asks the current window to set its title, through the lazy window API", async () => {
    const g = globalThis as { window?: Record<string, unknown> };
    const calls: Array<[string, unknown]> = [];
    const saved = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
        invoke: async (command: string, args: unknown) => {
          calls.push([command, args]);
          return command === "plugin:window|title" ? "Exo" : null;
        },
        transformCallback: () => 1,
      },
    };
    try {
      expect(await tauriWindowTitleTarget.read()).toBe("Exo");
      await tauriWindowTitleTarget.write("● 0:42 · Exo");
    } finally {
      g.window = saved;
    }
    expect(calls).toEqual([
      ["plugin:window|title", { label: "main" }],
      ["plugin:window|set_title", { label: "main", value: "● 0:42 · Exo" }],
    ]);
  });
});

describe("useRecordingTitle", () => {
  let restoreEnv: () => void;
  let clock: ReturnType<typeof fakeClock>;
  beforeEach(() => {
    restoreEnv = installReactTestEnv();
    clock = fakeClock();
  });
  afterEach(() => {
    clock.restore();
    restoreEnv();
  });

  function Probe({ target }: { target: TitleTarget | null }) {
    useRecordingTitle(target);
    return null;
  }
  const tree = (value: Partial<RecorderValue>, target: TitleTarget | null) => (
    <PlatformContext.Provider value="web">
      <StaticRecorderProvider value={value}>
        <Probe target={target} />
      </StaticRecorderProvider>
    </PlatformContext.Provider>
  );
  const live = (extra: Partial<RecorderValue> = {}): Partial<RecorderValue> => ({
    phase: "recording",
    mic: { state: "recording", reason: null },
    startedAt: clock.now - 42_000,
    elapsedMs: 42_000,
    elapsedAt: clock.now,
    ...extra,
  });

  test("shows the time, follows pause and the clock, and puts the title back after stop", async () => {
    const { target } = memoryTarget("TinyCloud Chat");
    const view = mount();
    await view.render(tree({}, target));
    await settle();
    expect(target.title).toBe("TinyCloud Chat");

    await view.render(tree(live(), target));
    await settle();
    expect(target.title).toBe("● 0:42 · Exo");

    await clock.advance(1_000);
    await settle();
    expect(target.title).toBe("● 0:43 · Exo");

    await view.render(tree(live({ mic: { state: "paused", reason: "user" }, elapsedMs: 43_000, elapsedAt: clock.now }), target));
    await settle();
    expect(target.title).toBe("❚❚ 0:43 · Exo");
    await clock.advance(5_000);
    await settle();
    expect(target.title).toBe("❚❚ 0:43 · Exo");

    await view.render(tree({ phase: "idle" }, target));
    await settle();
    expect(target.title).toBe("TinyCloud Chat");
    await view.unmount();
  });

  test("time comes from timestamps: a jump of a minute shows a minute, not one tick", async () => {
    const { target } = memoryTarget("TinyCloud Chat");
    const view = mount();
    await view.render(tree(live(), target));
    await clock.advance(60_000);
    await settle();
    expect(target.title).toBe("● 1:42 · Exo");
    await view.unmount();
  });

  test("unmounting mid-recording restores the title", async () => {
    const { target } = memoryTarget("TinyCloud Chat");
    const view = mount();
    await view.render(tree(live(), target));
    await settle();
    expect(target.title).toBe("● 0:42 · Exo");
    await view.unmount();
    await settle();
    expect(target.title).toBe("TinyCloud Chat");
  });
});
