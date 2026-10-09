import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StaticRecorderProvider, type RecorderValue } from "../RecorderProvider";
import { finishWithNote, type DoneGate } from "./doneGate";
import { clearNotesUi, readNotesUi, updateNotesUi, useNotesLifecycle } from "./notes";
import { useNoteSaver, type NoteSaving } from "./useNoteSaver";

// A root over a stand-in container: the components here render nothing, so only React's effects run.
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
beforeEach(clearNotesUi);
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  clearNotesUi();
});

async function show(node: ReactNode) {
  root ??= createRoot(container());
  await act(async () => root!.render(node));
}
const unmount = async () => {
  await act(async () => root!.unmount());
  root = null;
};

describe("useNoteSaver: the saver lives above the sheet", () => {
  let saving: NoteSaving;
  const writes: string[] = [];
  const mode = { fail: false };
  function Probe({ id, status = "ready" }: { id: string | null; status?: "loading" | "ready" | "error" }) {
    saving = useNoteSaver(id, {
      noteStatus: status,
      setNoteText: async (md) => {
        writes.push(md);
        if (mode.fail) throw new Error("write refused");
      },
    });
    return null;
  }
  beforeEach(() => {
    writes.length = 0;
    mode.fail = false;
  });

  test("a close flush that rejects leaves the failure and the draft in the state, where the recorder reads them", async () => {
    updateNotesUi("1", () => ({ open: true, view: "write" }));
    await show(<Probe id="1" />);
    mode.fail = true;
    await act(async () => {
      updateNotesUi("1", () => ({ draft: "typed" }));
      saving.change("typed");
      updateNotesUi("1", () => ({ open: false }));
      saving.saveNow();
    });
    expect(readNotesUi("1")).toMatchObject({ open: false, draft: "typed", saveFailed: true });
  });

  test("a rejected write followed by Done does not stop the recording; the next Done for the same text does", async () => {
    await show(<Probe id="1" />);
    mode.fail = true;
    await act(async () => {
      updateNotesUi("1", () => ({ draft: "typed" }));
      saving.change("typed");
    });
    const gate: DoneGate = { acknowledged: null };
    const stops: string[] = [];
    const done = () =>
      finishWithNote(gate, {
        flush: saving.flush,
        unsaved: () => readNotesUi("1")?.draft ?? null,
        stop: () => void stops.push("stop"),
        onUnsaved: () => {},
      });
    await act(async () => expect(await done()).toBe("blocked"));
    expect(stops).toEqual([]);
    expect(readNotesUi("1")?.saveFailed).toBe(true);
    await act(async () => expect(await done()).toBe("stopped"));
    expect(stops).toEqual(["stop"]);
  });

  test("a save that works clears the failure and the draft", async () => {
    await show(<Probe id="1" />);
    mode.fail = true;
    await act(async () => {
      updateNotesUi("1", () => ({ draft: "typed" }));
      saving.change("typed");
      saving.saveNow();
    });
    expect(readNotesUi("1")?.saveFailed).toBe(true);
    mode.fail = false;
    await act(async () => saving.flush());
    expect(readNotesUi("1")).toMatchObject({ saveFailed: false, draft: null });
    expect(writes).toEqual(["typed", "typed"]);
  });

  test("the view going away commits what was typed", async () => {
    await show(<Probe id="1" />);
    await act(async () => saving.change("typed last"));
    await unmount();
    expect(writes).toEqual(["typed last"]);
  });

  test("a new recording never receives the old one's text", async () => {
    await show(<Probe id="1" />);
    await act(async () => saving.change("old words"));
    await show(<Probe id="2" />);
    await act(async () => saving.saveNow());
    await unmount();
    expect(writes).toEqual([]);
  });

  test("text typed while the note loads is written once it is ready, not before", async () => {
    await show(<Probe id="1" status="loading" />);
    await act(async () => {
      updateNotesUi("1", () => ({ draft: "early" }));
      saving.change("early");
    });
    await act(async () => saving.saveNow());
    expect(writes).toEqual([]);
    expect(readNotesUi("1")?.saveFailed).toBe(true);
    await show(<Probe id="1" status="ready" />);
    await act(async () => saving.flush());
    expect(writes).toEqual(["early"]);
  });
});

describe("useNotesLifecycle", () => {
  function Shell() {
    useNotesLifecycle();
    return null;
  }
  const live = (startedAt: number | null): Partial<RecorderValue> => ({ phase: "recording", startedAt });
  const mount = (patch: Partial<RecorderValue>) => (
    <StaticRecorderProvider value={patch}>
      <Shell />
    </StaticRecorderProvider>
  );

  test("keeps the state while the same recording is going", async () => {
    updateNotesUi("5", () => ({ draft: "x" }));
    await show(mount(live(5)));
    await show(mount({ ...live(5), audioMs: 1000 }));
    expect(readNotesUi("5")?.draft).toBe("x");
  });

  test("clears it when the recording ends, with no view mounted", async () => {
    updateNotesUi("5", () => ({ draft: "x", open: true }));
    await show(mount(live(5)));
    await show(mount({ phase: "idle", startedAt: null }));
    expect(readNotesUi("5")).toBeNull();
  });

  test("clears the old recording's state when another one starts", async () => {
    updateNotesUi("5", () => ({ draft: "x" }));
    await show(mount(live(5)));
    await show(mount(live(6)));
    expect(readNotesUi("5")).toBeNull();
  });

  test("unmounting once the recording is no longer live (Done, discard) clears it", async () => {
    updateNotesUi("5", () => ({ draft: "x" }));
    await show(mount({ phase: "saving", startedAt: 5 }));
    await unmount();
    expect(readNotesUi("5")).toBeNull();
  });

  test("unmounting while still recording (minimised, layout switch) keeps it", async () => {
    updateNotesUi("5", () => ({ draft: "x" }));
    await show(mount(live(5)));
    await unmount();
    expect(readNotesUi("5")?.draft).toBe("x");
  });
});
