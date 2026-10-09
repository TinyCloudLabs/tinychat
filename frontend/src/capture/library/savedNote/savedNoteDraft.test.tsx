import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearSavedNoteDrafts, readSavedNoteDraft, useSavedNoteDraft, type SavedNoteDraft } from "./savedNoteDraft";

// A root over a stand-in container: the probes render nothing, so only React's effects and stores run.
const container = () =>
  ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});
beforeEach(clearSavedNoteDrafts);
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  clearSavedNoteDrafts();
});

async function show(node: ReactNode) {
  root ??= createRoot(container());
  await act(async () => root!.render(node));
}
const unmount = async () => {
  await act(async () => root!.unmount());
  root = null;
};

let handle: SavedNoteDraft;
function Probe({ id }: { id: string }) {
  handle = useSavedNoteDraft(id);
  return null;
}

describe("saved note draft", () => {
  test("a draft survives a switch between the page and the sheet (unmount, remount)", async () => {
    await show(<Probe id="rec-1" />);
    await act(async () => handle.edit("saved text"));
    await act(async () => handle.type("saved text, and more"));
    await unmount();
    await show(<Probe id="rec-1" />);
    expect(handle.draft).toBe("saved text, and more");
    expect(handle.confirming).toBeNull();
  });

  test("a draft belongs to its recording", async () => {
    await show(<Probe id="rec-1" />);
    await act(async () => handle.edit("one"));
    await show(<Probe id="rec-2" />);
    expect(handle.draft).toBeNull();
    expect(readSavedNoteDraft("rec-1").draft).toBe("one");
  });

  test("Cancel with changes asks and keeping goes back to editing", async () => {
    await show(<Probe id="rec-1" />);
    await act(async () => handle.edit("a"));
    await act(async () => handle.type("b"));
    await act(async () => handle.cancel("a"));
    expect(handle.confirming).toBe("cancel");
    await act(async () => handle.keep());
    expect(handle).toMatchObject({ draft: "b", confirming: null });
  });

  test("closing with changes asks and keeps the draft; discarding then closes", async () => {
    await show(<Probe id="rec-1" />);
    await act(async () => handle.edit("a"));
    await act(async () => handle.type("b"));
    let closed = true;
    await act(async () => {
      closed = handle.close("a");
    });
    expect(closed).toBe(false);
    expect(handle).toMatchObject({ draft: "b", confirming: "close" });
    let closing = false;
    await act(async () => {
      closing = handle.discard();
    });
    expect(closing).toBe(true);
    expect(handle).toMatchObject({ draft: null, confirming: null });
  });

  test("saving finishes the edit", async () => {
    await show(<Probe id="rec-1" />);
    await act(async () => handle.edit("a"));
    await act(async () => handle.type("b"));
    await act(async () => handle.finish());
    expect(handle.draft).toBeNull();
    expect(readSavedNoteDraft("rec-1").draft).toBeNull();
  });
});
