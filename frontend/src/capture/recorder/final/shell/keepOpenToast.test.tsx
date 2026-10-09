import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RecorderPhase } from "../../recorderReducer";
import type { RecorderLayout } from "../shellCapabilities";
import { installReactTestEnv, mount } from "./hookTestUtil";
import { keepOpenMessage, KEEP_PAGE_OPEN, KEEP_TAB_OPEN, useKeepOpenToast } from "./keepOpenToast";

describe("keepOpenMessage", () => {
  test("a tab in the desktop layout, a page in the phone layout", () => {
    expect(keepOpenMessage("desktop")).toBe("Keep this tab open while you record");
    expect(keepOpenMessage("rail")).toBe(KEEP_TAB_OPEN);
    expect(keepOpenMessage("phone")).toBe("Keep this page open while you record");
  });
});

describe("useKeepOpenToast", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = installReactTestEnv();
  });
  afterEach(() => restoreEnv());

  function setup(initial: RecorderPhase) {
    const shown: string[] = [];
    function Probe({ phase, layout = "desktop", enabled = true }: { phase: RecorderPhase; layout?: RecorderLayout; enabled?: boolean }) {
      useKeepOpenToast(enabled, phase, layout, (message) => shown.push(message));
      return null;
    }
    return { shown, Probe, view: mount(), initial };
  }

  test("once per recording, when it starts; pausing and resuming do not repeat it", async () => {
    const { shown, Probe, view } = setup("idle");
    await view.render(<Probe phase="idle" />);
    await view.render(<Probe phase="starting" />);
    expect(shown).toEqual([]);
    await view.render(<Probe phase="recording" />);
    await view.render(<Probe phase="recording" />);
    expect(shown).toEqual([KEEP_TAB_OPEN]);
    await view.render(<Probe phase="stopping" />);
    await view.render(<Probe phase="saving" />);
    await view.render(<Probe phase="idle" />);
    await view.render(<Probe phase="starting" />);
    await view.render(<Probe phase="recording" />);
    expect(shown).toEqual([KEEP_TAB_OPEN, KEEP_TAB_OPEN]);
    await view.unmount();
  });

  test("the phone layout gets the page wording", async () => {
    const { shown, Probe, view } = setup("idle");
    await view.render(<Probe phase="starting" layout="phone" />);
    await view.render(<Probe phase="recording" layout="phone" />);
    expect(shown).toEqual([KEEP_PAGE_OPEN]);
    await view.unmount();
  });

  test("a recording already running when the page mounts is not a start", async () => {
    const { shown, Probe, view } = setup("recording");
    await view.render(<Probe phase="recording" />);
    expect(shown).toEqual([]);
    await view.unmount();
  });

  test("nothing when it is not enabled (not the web)", async () => {
    const { shown, Probe, view } = setup("idle");
    await view.render(<Probe phase="starting" enabled={false} />);
    await view.render(<Probe phase="recording" enabled={false} />);
    expect(shown).toEqual([]);
    await view.unmount();
  });
});
