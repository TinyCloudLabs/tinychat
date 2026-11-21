import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { retryAfterHide } from "./retryAfterHide";

let restoreDom: () => void;
beforeEach(() => { restoreDom = installDom(); });
afterEach(() => { setVisibility("visible"); restoreDom(); });

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A write that fails `failures` times, then lands; `calls` counts its attempts and `shown` records the page's visibility at each. */
function write(failures: number, afterFailure?: () => void) {
  const state = { calls: 0, shown: [] as string[] };
  const attempt = async () => {
    state.calls++;
    state.shown.push(document.visibilityState);
    if (state.calls <= failures) { afterFailure?.(); throw new Error("network"); }
    return "saved";
  };
  return { state, attempt };
}

test("a write that failed as the page was hidden is sent once more, and only into a visible page", async () => {
  const { state, attempt } = write(1, () => { setVisibility("hidden"); queueMicrotask(() => setVisibility("visible")); });
  expect(await retryAfterHide(attempt, () => true, 0)).toBe("saved");
  expect(state.shown).toEqual(["visible", "visible"]);
});

test("a write that failed after the page came back is sent again", async () => {
  const { state, attempt } = write(1, () => { setVisibility("hidden"); setVisibility("visible"); });
  expect(await retryAfterHide(attempt, () => true, 0)).toBe("saved");
  expect(state.calls).toBe(2);
});

test("a failure with the page visible all along is not sent again", async () => {
  const { state, attempt } = write(1);
  await expect(retryAfterHide(attempt, () => true, 0)).rejects.toThrow("network");
  expect(state.calls).toBe(1);
});

test("an answer that is no longer held, as when the node refused it, is not sent again", async () => {
  const { state, attempt } = write(1, () => { setVisibility("hidden"); setVisibility("visible"); });
  await expect(retryAfterHide(attempt, () => false, 0)).rejects.toThrow("network");
  expect(state.calls).toBe(1);
});

test("only one more send: a second failure is the caller's", async () => {
  const { state, attempt } = write(2, () => { setVisibility("hidden"); setVisibility("visible"); });
  await expect(retryAfterHide(attempt, () => true, 0)).rejects.toThrow("network");
  expect(state.calls).toBe(2);
});

test("a write that succeeds is never repeated", async () => {
  const { state, attempt } = write(0);
  expect(await retryAfterHide(attempt, () => true, 0)).toBe("saved");
  expect(state.calls).toBe(1);
});
