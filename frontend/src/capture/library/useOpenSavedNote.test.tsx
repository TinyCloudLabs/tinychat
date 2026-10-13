// The recorder's Open, mounted (TC-761): the Library at once, then the note
// just saved once its row is found; the Library stays when the row is not
// found, or when the user has moved on before the read answered.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { useOpenSavedNote } from "./useOpenSavedNote";

const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

let spaces = 0;
/** A space whose one lookup waits for the test. */
function fakeSpace() {
  const lookups: Array<{ params: unknown[]; answer: (value: unknown) => void }> = [];
  spaces += 1;
  const tcw = {
    did: `did:test:open-${spaces}`,
    spaceId: `open-${spaces}`,
    sql: { db: () => ({ query: (_sql: string, params: unknown[]) => new Promise((answer) => lookups.push({ params, answer })) }) },
  } as unknown as TinyCloudWeb;
  return { tcw, lookups };
}

interface Seen {
  open: (recordingId: string) => void;
  navigate: NavigateFunction;
  path: string;
}
function Probe(props: { tcw: TinyCloudWeb; seen: Seen[] }) {
  const open = useOpenSavedNote(props.tcw);
  const navigate = useNavigate();
  props.seen.push({ open, navigate, path: useLocation().pathname });
  return null;
}
const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});
async function mount(tcw: TinyCloudWeb, seen: Seen[]) {
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Probe tcw={tcw} seen={seen} />
      </MemoryRouter>,
    ),
  );
}

describe("useOpenSavedNote, mounted", () => {
  test("the Library at once; the note once its row is found", async () => {
    const { tcw, lookups } = fakeSpace();
    const seen: Seen[] = [];
    await mount(tcw, seen);
    await act(async () => seen.at(-1)!.open("rec-1"));
    // Pending: the Library shows while the one lookup is out.
    expect(seen.at(-1)!.path).toBe("/chat/capture/library");
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.params).toEqual(["exo-voice-note", "rec-1"]);
    // Found: the note itself.
    await act(async () => lookups[0]!.answer({ ok: true, data: { rows: [["row-9"]] } }));
    await act(async () => {});
    expect(seen.at(-1)!.path).toBe("/chat/capture/library/row-9");
  });

  test("not found, or the user moved on: the Library (or where they went) stays", async () => {
    const missing = fakeSpace();
    const seen: Seen[] = [];
    await mount(missing.tcw, seen);
    await act(async () => seen.at(-1)!.open("rec-1"));
    await act(async () => missing.lookups[0]!.answer({ ok: true, data: { rows: [] } }));
    await act(async () => {});
    expect(seen.at(-1)!.path).toBe("/chat/capture/library");
    await act(async () => root!.unmount());
    root = null;

    const slow = fakeSpace();
    const later: Seen[] = [];
    await mount(slow.tcw, later);
    await act(async () => later.at(-1)!.open("rec-2"));
    await act(async () => later.at(-1)!.navigate("/chat"));
    await act(async () => slow.lookups[0]!.answer({ ok: true, data: { rows: [["row-7"]] } }));
    await act(async () => {});
    expect(later.at(-1)!.path).toBe("/chat");
  });
});
