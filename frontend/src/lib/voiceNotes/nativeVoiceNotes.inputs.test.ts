import { afterEach, describe, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import {
  __setVoiceNotesForTests,
  listInputs,
  onInputsChanged,
  selectInput,
  type VoiceNotesPlugin,
} from "./nativeVoiceNotes";

function counted() {
  const { plugin } = createFakeVoiceNotes();
  const count = { added: 0, removed: 0 };
  const wrapped = {
    ...plugin,
    addListener: ((event: string, listener: never) => {
      if (event === "inputs") count.added++;
      return (
        plugin.addListener as (
          e: string,
          l: never,
        ) => Promise<{ remove(): Promise<void> }>
      )(event, listener).then((handle) => ({
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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

afterEach(() =>
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: null }),
);

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
    await settle();
    expect(count.removed).toBe(1);

    const offC = onInputsChanged(() => {});
    await settle();
    expect(count.added).toBe(2);
    offC();
    await settle();
  });

  test("a resubscribe during a slow removal waits for it: never two native listeners", async () => {
    const { plugin } = createFakeVoiceNotes();
    let live = 0;
    let peak = 0;
    let added = 0;
    let release!: () => void;
    const slowRemove = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    __setVoiceNotesForTests(
      {
        ...plugin,
        addListener: (async () => {
          added++;
          live++;
          peak = Math.max(peak, live);
          const slow = first;
          first = false;
          return {
            remove: async () => {
              if (slow) await slowRemove;
              live--;
            },
          };
        }) as VoiceNotesPlugin["addListener"],
      } as VoiceNotesPlugin,
      { available: true },
    );

    const offA = onInputsChanged(() => {});
    await settle();
    expect(added).toBe(1);

    offA();
    await settle();
    expect(live).toBe(1);
    const offB = onInputsChanged(() => {});
    await settle();
    expect(added).toBe(1);
    expect(live).toBe(1);

    release();
    await settle();
    expect(added).toBe(2);
    expect(live).toBe(1);
    expect(peak).toBe(1);
    offB();
    await settle();
    expect(live).toBe(0);
  });

  test("a failing add or remove is logged and handed to the subscribers", async () => {
    const { plugin } = createFakeVoiceNotes();
    let failAdd = true;
    __setVoiceNotesForTests(
      {
        ...plugin,
        addListener: (async () => {
          if (failAdd) throw new Error("no listener");
          return { remove: async () => Promise.reject(new Error("no remove")) };
        }) as VoiceNotesPlugin["addListener"],
      } as VoiceNotesPlugin,
      { available: true },
    );
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args[1]);
    const seen: string[] = [];
    try {
      const off = onInputsChanged(
        () => {},
        (caught) => seen.push((caught as Error).message),
      );
      await settle();
      expect(seen).toEqual(["no listener"]);

      failAdd = false;
      const again = onInputsChanged(
        () => {},
        (caught) => seen.push((caught as Error).message),
      );
      await settle();
      off();
      again();
      await settle();
      const messages = logged.map((caught) => (caught as Error).message);
      expect(messages[0]).toBe("no listener");
      expect(messages.slice(1).length).toBeGreaterThan(0);
      expect(new Set(messages.slice(1))).toEqual(new Set(["no remove"]));
    } finally {
      console.error = original;
    }
  });
});
