import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { installDom } from "@/test/dom";
import { CALL_PROMPT_CLICK_GUARD_MS, CALL_PROMPT_EVENT, mountCallPromptTile, readCallPromptPhase, type CallPromptBridge, type CallPromptTile } from "./tile";

// The "Record this call" tile over a scripted bridge: it shows the phase the native side sends, and passes on the two
// clicks without ever being left stuck.

interface Pending {
  resolve(value?: unknown): void;
  reject(error: unknown): void;
}

function fakeBridge(state: unknown = { phase: "offered" }) {
  const invoked: string[] = [];
  const answers = new Map<string, Pending>();
  let handler: ((event: { payload: unknown }) => void) | null = null;
  let unlistened = 0;
  const bridge: CallPromptBridge = {
    invoke(command) {
      invoked.push(command);
      if (command === "call_prompt_state") return Promise.resolve(state);
      return new Promise((resolve, reject) => answers.set(command, { resolve, reject }));
    },
    async listen(event, next) {
      expect(event).toBe(CALL_PROMPT_EVENT);
      handler = next;
      return () => { unlistened++; };
    },
  };
  return {
    bridge,
    invoked,
    emit: (payload: unknown) => handler?.({ payload }),
    answer: (command: string) => answers.get(command)!,
    unlistened: () => unlistened,
  };
}

let restoreDom: (() => void) | null = null;
let tile: CallPromptTile | null = null;
afterEach(() => {
  tile?.dispose();
  tile = null;
  restoreDom?.();
  restoreDom = null;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Mounts the tile on a clock of its own; unless `guarded`, the clock then moves past the click guard. */
async function mount(state?: unknown, { guarded = false } = {}) {
  restoreDom = installDom();
  const root = document.createElement("main");
  document.body.append(root);
  const fake = fakeBridge(state);
  let clock = 1_000;
  tile = mountCallPromptTile(root, fake.bridge, { now: () => clock });
  await settle();
  if (!guarded) clock += CALL_PROMPT_CLICK_GUARD_MS;
  const button = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name) ?? null;
  return {
    ...fake,
    root,
    start: () => button("Start"),
    dismiss: () => button("Not now"),
    dot: () => root.querySelector(".cp-dot"),
    label: () => root.querySelector(".cp-label")?.textContent ?? null,
    advance: (ms: number) => { clock += ms; },
  };
}

describe("readCallPromptPhase", () => {
  test("the four phases; anything else is hidden", () => {
    for (const phase of ["hidden", "offered", "starting", "recording"])
      expect(readCallPromptPhase({ phase })).toBe(phase);
    for (const answer of [null, undefined, "offered", {}, { phase: "joined" }, { phase: 1 }, { state: "offered" }])
      expect(readCallPromptPhase(answer)).toBe("hidden");
  });
});

describe("the call prompt tile", () => {
  test("offered: the mark, the label and two enabled buttons, nothing else", async () => {
    const view = await mount({ phase: "offered" });
    expect(view.invoked).toEqual(["call_prompt_state"]);
    expect(view.label()).toBe("Record this call");
    expect(view.root.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(view.start()?.disabled).toBe(false);
    expect(view.dismiss()?.disabled).toBe(false);
    expect(view.start()?.getAttribute("type")).toBe("button");
    expect(view.dot()).toBeNull();
    expect(view.root.textContent).toBe("Record this callStartNot now");
    expect(view.root.querySelector("[title]")).toBeNull();
  });

  test("hidden renders nothing", async () => {
    const view = await mount({ phase: "hidden" });
    expect(view.root.childElementCount).toBe(0);
  });

  test("an unknown phase, or a malformed answer, is treated as hidden", async () => {
    const view = await mount({ phase: "joined" });
    expect(view.root.childElementCount).toBe(0);
    view.emit({ phase: "offered" });
    expect(view.start()).not.toBeNull();
    view.emit({ phase: "lobby" });
    expect(view.root.childElementCount).toBe(0);
    view.emit("offered");
    expect(view.root.childElementCount).toBe(0);
  });

  test("starting: the buttons are disabled", async () => {
    const view = await mount({ phase: "starting" });
    expect(view.label()).toBe("Record this call");
    expect(view.start()?.disabled).toBe(true);
    expect(view.dismiss()?.disabled).toBe(true);
  });

  test("recording: a red dot in place of the buttons", async () => {
    const view = await mount({ phase: "offered" });
    view.emit({ phase: "recording" });
    expect(view.start()).toBeNull();
    expect(view.dismiss()).toBeNull();
    expect(view.dot()?.getAttribute("role")).toBe("img");
    expect(view.label()).toBe("Record this call");
    // A later call offers again: the buttons come back.
    view.emit({ phase: "hidden" });
    view.emit({ phase: "offered" });
    expect(view.dot()).toBeNull();
    expect(view.start()?.disabled).toBe(false);
  });

  test("each event renders its phase", async () => {
    const view = await mount({ phase: "hidden" });
    view.emit({ phase: "offered" });
    expect(view.start()?.disabled).toBe(false);
    view.emit({ phase: "starting" });
    expect(view.start()?.disabled).toBe(true);
    view.emit({ phase: "hidden" });
    expect(view.root.childElementCount).toBe(0);
  });

  test("Start disables both buttons at once and asks the app once", async () => {
    const view = await mount({ phase: "offered" });
    view.start()!.click();
    expect(view.start()?.disabled).toBe(true);
    expect(view.dismiss()?.disabled).toBe(true);
    view.start()!.click();
    view.dismiss()!.click();
    expect(view.invoked).toEqual(["call_prompt_state", "call_prompt_start"]);
    view.answer("call_prompt_start").resolve();
    await settle();
    // Disabled until the native side sends what comes next.
    expect(view.start()?.disabled).toBe(true);
    view.emit({ phase: "starting" });
    expect(view.start()?.disabled).toBe(true);
    view.emit({ phase: "recording" });
    expect(view.dot()).not.toBeNull();
  });

  test("Not now asks the app to dismiss", async () => {
    const view = await mount({ phase: "offered" });
    view.dismiss()!.click();
    expect(view.invoked).toEqual(["call_prompt_state", "call_prompt_dismiss"]);
    expect(view.start()?.disabled).toBe(true);
    view.answer("call_prompt_dismiss").resolve();
    view.emit({ phase: "hidden" });
    expect(view.root.childElementCount).toBe(0);
  });

  test("a failed Start or Not now re-enables the buttons and logs one error", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = await mount({ phase: "offered" });
      view.start()!.click();
      view.answer("call_prompt_start").reject(new Error("no window"));
      await settle();
      expect(view.start()?.disabled).toBe(false);
      expect(view.dismiss()?.disabled).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      view.dismiss()!.click();
      view.answer("call_prompt_dismiss").reject("refused");
      await settle();
      expect(view.dismiss()?.disabled).toBe(false);
      expect(error).toHaveBeenCalledTimes(2);
    } finally { error.mockRestore(); }
  });

  test("a failed first read shows nothing and logs one error; the next event still renders", async () => {
    restoreDom = installDom();
    const root = document.createElement("main");
    const fake = fakeBridge();
    fake.bridge.invoke = async () => { throw new Error("Command call_prompt_state not found"); };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      tile = mountCallPromptTile(root, fake.bridge);
      await settle();
      expect(root.childElementCount).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
      fake.emit({ phase: "offered" });
      expect(root.querySelectorAll("button").length).toBe(2);
    } finally { error.mockRestore(); }
  });

  test("listens before it asks, and an event wins over a late first answer", async () => {
    restoreDom = installDom();
    const root = document.createElement("main");
    const order: string[] = [];
    let answer: (value: unknown) => void = () => {};
    let handler: ((event: { payload: unknown }) => void) | null = null;
    tile = mountCallPromptTile(root, {
      invoke: (command) => { order.push(command); return new Promise((resolve) => { answer = resolve; }); },
      listen: async (_event, next) => { order.push("listen"); handler = next; return () => {}; },
    });
    await settle();
    expect(order).toEqual(["listen", "call_prompt_state"]);
    handler!({ payload: { phase: "recording" } });
    answer({ phase: "offered" });
    await settle();
    expect(root.querySelector(".cp-dot")).not.toBeNull();
  });

  test("a newly offered tile ignores clicks for half a second, without looking any different", async () => {
    const view = await mount({ phase: "offered" }, { guarded: true });
    view.advance(100);
    view.start()!.click();
    view.dismiss()!.click();
    expect(view.invoked).toEqual(["call_prompt_state"]);
    expect(view.start()?.disabled).toBe(false);
    expect(view.dismiss()?.disabled).toBe(false);
    view.advance(500);
    view.start()!.click();
    expect(view.invoked).toEqual(["call_prompt_state", "call_prompt_start"]);
  });

  test("the guard starts again when a new offer follows hidden, and not for an offer sent again", async () => {
    const view = await mount({ phase: "offered" }, { guarded: true });
    view.advance(600);
    view.emit({ phase: "offered" });
    view.dismiss()!.click();
    expect(view.invoked).toEqual(["call_prompt_state", "call_prompt_dismiss"]);
    view.emit({ phase: "hidden" });
    view.advance(1000);
    view.emit({ phase: "offered" });
    view.advance(100);
    view.start()!.click();
    expect(view.invoked).toEqual(["call_prompt_state", "call_prompt_dismiss"]);
    view.advance(500);
    view.start()!.click();
    expect(view.invoked).toEqual(["call_prompt_state", "call_prompt_dismiss", "call_prompt_start"]);
  });

  test("dispose stops listening", async () => {
    const view = await mount({ phase: "offered" });
    tile!.dispose();
    tile = null;
    expect(view.unlistened()).toBe(1);
  });
});
