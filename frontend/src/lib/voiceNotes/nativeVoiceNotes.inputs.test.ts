import { afterEach, describe, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, listInputs, onInputsChanged, selectInput, type VoiceNotesPlugin } from "./nativeVoiceNotes";

function counted() {
  const { plugin } = createFakeVoiceNotes();
  const count = { added: 0, removed: 0 };
  const wrapped = {
    ...plugin,
    addListener: ((event: string, listener: never) => {
      if (event === "inputs") count.added++;
      return (plugin.addListener as (e: string, l: never) => Promise<{ remove(): Promise<void> }>)(event, listener).then((handle) => ({
        remove: async () => {
          if (event === "inputs") count.removed++;
          await handle.remove();
        },
      }));
    }) as VoiceNotesPlugin["addListener"],
  } as VoiceNotesPlugin;
  __setVoiceNotesForTests(wrapped, { available: true });
  return { count };
}

afterEach(() => __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: null }));

describe("input wrappers", () => {
  test("lists and selects through the plugin", async () => {
    counted();
    const { inputs } = await listInputs();
    expect(inputs.map((input) => input.id)).toEqual(["built-in"]);
    await selectInput("built-in");
    expect((await listInputs()).selectedId).toBe("built-in");
  });

  test("one native listener fans out to every subscriber, and goes with the last", async () => {
    const { count } = counted();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = onInputsChanged((snapshot) => a.push(snapshot.selectedId));
    const offB = onInputsChanged((snapshot) => b.push(snapshot.selectedId));
    await Promise.resolve();
    expect(count.added).toBe(1);

    await selectInput("built-in");
    expect(a).toEqual(["built-in"]);
    expect(b).toEqual(["built-in"]);

    offA();
    await selectInput(null);
    expect(a).toEqual(["built-in"]);
    expect(b).toEqual(["built-in", null]);
    expect(count.removed).toBe(0);

    offB();
    await Promise.resolve();
    await Promise.resolve();
    expect(count.removed).toBe(1);

    const offC = onInputsChanged(() => {});
    expect(count.added).toBe(2);
    offC();
  });
});
