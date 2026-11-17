import { afterEach, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { AnswerOptions, OwnAnswerBox, OWN_OPTION } from "./AnswerOptions";
import { UNDO_SECONDS } from "./cardKit";

const OPTIONS = [{ id: "a", label: "Raise the limit" }, { id: "b", label: "Keep the limit" }];
let restore: (() => void) | undefined;
const roots = new Set<{ root: Root; host: HTMLElement }>();
afterEach(async () => { for (const { root, host } of roots) { await act(async () => root.unmount()); host.remove(); } roots.clear(); restore?.(); restore = undefined; });

function Harness({ pending, onUndo }: { pending?: { choiceId: string; seconds: number } | null; onUndo?: () => void }) {
  const [open, setOpen] = useState(pending?.choiceId === OWN_OPTION.id);
  const [text, setText] = useState("");
  return <AnswerOptions options={OPTIONS} pending={pending ?? null} onChoose={() => undefined} onUndo={onUndo ?? (() => undefined)}
    own={{ open, onOpen: setOpen, box: <OwnAnswerBox text={text} disabled={!!pending} onText={setText} onSend={() => undefined} onCancel={() => setOpen(false)} /> }} />;
}
async function mountOptions(props: Parameters<typeof Harness>[0] = {}) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add({ root, host });
  await act(async () => root.render(<Harness {...props} />));
  const fieldset = host.querySelector("fieldset")!;
  const grid = () => fieldset.querySelector<HTMLElement>(":scope > div")!;
  return { host, fieldset, grid, slots: () => [...grid().children] as HTMLElement[] };
}
const buttonIn = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim().startsWith(label));

test("Your own answer turns into the text field in the third option's slot, and nothing is added below", async () => {
  const view = await mountOptions();
  expect(view.slots()).toHaveLength(3);
  expect(buttonIn(view.slots()[2]!, "Your own answer")).toBeDefined();
  expect(view.fieldset.querySelector("textarea")).toBeNull();

  await act(async () => buttonIn(view.slots()[2]!, "Your own answer")!.click());
  // The same three slots: the field is in the third, the button is gone, and the grid's only sibling after it is the screen-reader status line.
  expect(view.slots()).toHaveLength(3);
  expect(view.slots()[2]!.querySelector("textarea")).not.toBeNull();
  expect(buttonIn(view.slots()[2]!, "Your own answer")).toBeUndefined();
  expect(view.fieldset.querySelectorAll("textarea")).toHaveLength(1);
  expect([...view.fieldset.children].filter((node) => node !== view.grid() && node.tagName !== "LEGEND" && node.getAttribute("role") !== "status")).toHaveLength(0);

  // Cancel puts the button back in the same slot.
  await act(async () => (view.slots()[2]!.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement).click());
  expect(view.slots()).toHaveLength(3);
  expect(view.fieldset.querySelector("textarea")).toBeNull();
  expect(buttonIn(view.slots()[2]!, "Your own answer")).toBeDefined();
});

test("a tapped option shows its wait with Undo in its own slot; the others are off; Undo calls back once", async () => {
  const undo = mock(() => undefined);
  const view = await mountOptions({ pending: { choiceId: "b", seconds: 3 }, onUndo: undo });
  expect(view.slots()).toHaveLength(3);
  const held = view.slots()[1]!;
  expect(held.textContent).toContain("Sends in 3s");
  expect(view.fieldset.textContent).toContain(`${UNDO_SECONDS} seconds`);
  expect(UNDO_SECONDS).toBe(5);
  expect((buttonIn(view.slots()[0]!, "Raise the limit") as HTMLButtonElement).disabled).toBe(true);
  expect((buttonIn(view.slots()[2]!, "Your own answer") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => buttonIn(held, "Undo")!.click());
  expect(undo).toHaveBeenCalledTimes(1);
});

test("a written answer's wait and Undo lie over the same slot the field was in", async () => {
  const undo = mock(() => undefined);
  const view = await mountOptions({ pending: { choiceId: OWN_OPTION.id, seconds: 5 }, onUndo: undo });
  expect(view.slots()).toHaveLength(3);
  expect(view.slots()[2]!.textContent).toContain("Sends in 5s");
  expect(view.fieldset.querySelectorAll("textarea")).toHaveLength(1);
  await act(async () => buttonIn(view.slots()[2]!, "Undo")!.click());
  expect(undo).toHaveBeenCalledTimes(1);
});
