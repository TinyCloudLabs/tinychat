import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedNotePage } from "./SavedNoteView";
import { editedLabel } from "./savedNoteMeta";
import { clearSavedNoteDrafts, readSavedNoteDraft } from "./savedNoteDraft";
import type { SavedNoteRecord, SavedNoteStore } from "./savedNoteStore";
import { useSavedNoteScreen, type SavedNoteScreen } from "./useSavedNoteScreen";

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

let screen: SavedNoteScreen;
function Probe({ store }: { store: SavedNoteStore }) {
  screen = useSavedNoteScreen("rec-1", store);
  return null;
}

const record = (md: string): SavedNoteRecord => ({ md, editedAt: "2026-10-09T10:00:00Z" });
const writes: string[] = [];
const mode = { fail: false };
const store: SavedNoteStore = {
  load: async () => record("first line"),
  save: async (_id, md) => {
    writes.push(md);
    if (mode.fail) throw new Error("disk full");
    return { record: record(md), synced: Promise.resolve() };
  },
};
beforeEach(() => {
  writes.length = 0;
  mode.fail = false;
});

describe("useSavedNoteScreen", () => {
  test("Edit opens on the saved text; Save writes it, shows it and ends Edit", async () => {
    await show(<Probe store={store} />);
    expect(screen.savedMd).toBe("first line");
    expect(screen.editing).toBe(false);
    await act(async () => screen.startEdit());
    expect(screen.editing).toBe(true);
    expect(screen.dirty).toBe(false);
    await act(async () => screen.draft.type("first line\nsecond"));
    expect(screen.dirty).toBe(true);
    await act(async () => screen.save());
    expect(writes).toEqual(["first line\nsecond"]);
    expect(screen.savedMd).toBe("first line\nsecond");
    expect(screen.editing).toBe(false);
  });

  test("a save that fails shows the error and keeps what was typed, still in Edit", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    await show(<Probe store={store} />);
    await act(async () => screen.startEdit());
    await act(async () => screen.draft.type("typed"));
    mode.fail = true;
    await act(async () => screen.save());
    expect(screen.note.saveError).toBe("disk full");
    expect(screen.editing).toBe(true);
    expect(screen.draft.draft).toBe("typed");
    expect(screen.savedMd).toBe("first line");
    mode.fail = false;
    await act(async () => screen.save());
    expect(screen.note.saveError).toBeNull();
    expect(screen.editing).toBe(false);
    error.mockRestore();
  });

  test("Save with nothing changed writes nothing and ends Edit", async () => {
    await show(<Probe store={store} />);
    await act(async () => screen.startEdit());
    await act(async () => screen.save());
    expect(writes).toEqual([]);
    expect(screen.editing).toBe(false);
  });

  test("text typed while the save was in flight is kept as the new draft", async () => {
    let release: () => void = () => {};
    const slow: SavedNoteStore = {
      load: store.load,
      save: async (_id, md) => {
        await new Promise<void>((resolve) => (release = resolve));
        return { record: record(md), synced: Promise.resolve() };
      },
    };
    await show(<Probe store={slow} />);
    await act(async () => screen.startEdit());
    await act(async () => screen.draft.type("one"));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = screen.save();
    });
    await act(async () => screen.draft.type("one two"));
    await act(async () => {
      release();
      await pending;
    });
    expect(screen.savedMd).toBe("one");
    expect(readSavedNoteDraft("rec-1").draft).toBe("one two");
    expect(screen.editing).toBe(true);
  });

  test("playFrom hands the player a new request each time, even for the same second", async () => {
    await show(<Probe store={store} />);
    expect(screen.seek).toBeNull();
    await act(async () => screen.playFrom(8));
    const first = screen.seek;
    await act(async () => screen.playFrom(8));
    expect(first).toEqual({ seconds: 8, nonce: 1 });
    expect(screen.seek).toEqual({ seconds: 8, nonce: 2 });
  });

  test("the sheet's ✕ with changes asks first and keeps the draft", async () => {
    await show(<Probe store={store} />);
    await act(async () => screen.startEdit());
    await act(async () => screen.draft.type("changed"));
    let closed = true;
    await act(async () => {
      closed = screen.requestClose();
    });
    expect(closed).toBe(false);
    expect(screen.draft.confirming).toBe("close");
    expect(screen.draft.draft).toBe("changed");
  });

  test("Save turns the note view's Edited line to the time the store recorded", async () => {
    const dated: SavedNoteStore = {
      load: async () => ({ md: "first line", editedAt: "2026-10-08T09:00:00Z" }),
      save: async (_id, md) => ({
        record: { md, editedAt: "2026-10-09T03:20:00Z" },
        synced: Promise.resolve(),
      }),
    };
    const page = () =>
      renderToStaticMarkup(
        <SavedNotePage
          screen={screen}
          layout="page"
          theme="night"
          id="rec-1"
          title="Standup"
          meta=""
          loadAudio={null}
          transcript={null}
          partialAudio={false}
          onBack={() => {}}
        />,
      );
    await show(<Probe store={dated} />);
    expect(page()).toContain(`Edited ${editedLabel("2026-10-08T09:00:00Z")}`);
    await act(async () => screen.startEdit());
    await act(async () => screen.draft.type("first line\nsecond"));
    await act(async () => screen.save());
    const out = page();
    expect(out).toContain(`Edited ${editedLabel("2026-10-09T03:20:00Z")}`);
    expect(out).not.toContain(editedLabel("2026-10-08T09:00:00Z") + "<");
  });
});
