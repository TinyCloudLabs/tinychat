import { describe, expect, mock, test } from "bun:test";
import { chooseAudioInput, watchAudioInputs, type AudioInputsHandlers, type AudioInputsSource } from "./useAudioInputs";

const unsupported = () => Object.assign(new Error("unsupported"), { code: "unsupported" });
const snapshot = { inputs: [{ id: "a", name: "A", kind: "built_in" as const }], selectedId: null, activeId: "a" };

function handlers() {
  return { onSnapshot: mock(), onUnsupported: mock(), onError: mock() } satisfies AudioInputsHandlers;
}
const source = (over: Partial<AudioInputsSource>): AudioInputsSource => ({
  list: async () => snapshot,
  select: async () => {},
  subscribe: () => () => {},
  ...over,
});
const flush = () => new Promise((resolve) => setTimeout(resolve));

describe("audio inputs", () => {
  test("listing that is unsupported is a capability: no error, no log", async () => {
    const h = handlers();
    const error = mock();
    const original = console.error;
    console.error = error;
    try {
      watchAudioInputs(source({ list: async () => Promise.reject(unsupported()) }), h);
      await flush();
    } finally {
      console.error = original;
    }
    expect(h.onUnsupported).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("selecting that is unsupported is a capability too", async () => {
    const h = handlers();
    expect(await chooseAudioInput(source({ select: async () => Promise.reject(unsupported()) }), "a", h)).toBe(false);
    expect(h.onUnsupported).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
  });

  test("any other rejection is surfaced and logged", async () => {
    const h = handlers();
    const error = mock();
    const original = console.error;
    console.error = error;
    try {
      watchAudioInputs(source({ list: async () => Promise.reject(new Error("boom")) }), h);
      await flush();
      expect(await chooseAudioInput(source({ select: async () => Promise.reject(new Error("nope")) }), "a", h)).toBe(false);
    } finally {
      console.error = original;
    }
    expect(h.onUnsupported).not.toHaveBeenCalled();
    expect(h.onError.mock.calls).toEqual([["boom"], ["nope"]]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  test("delivers the list and changes, and stops after unsubscribe", async () => {
    const h = handlers();
    let push: (s: typeof snapshot) => void = () => {};
    const stop = watchAudioInputs(source({ subscribe: (listener) => ((push = listener), () => {}) }), h);
    await flush();
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);
    push(snapshot);
    expect(h.onSnapshot).toHaveBeenCalledTimes(2);
    stop();
    push(snapshot);
    expect(h.onSnapshot).toHaveBeenCalledTimes(2);
  });
});
