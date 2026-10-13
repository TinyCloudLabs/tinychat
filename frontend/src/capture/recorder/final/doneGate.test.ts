import { describe, expect, test } from "bun:test";
import { finishWithNote, type DoneGate } from "./doneGate";

function setup(opts: { fails?: boolean; unsaved?: string | null } = {}) {
  const gate: DoneGate = { acknowledged: null };
  const calls: string[] = [];
  const state = { fails: opts.fails ?? false, unsaved: opts.unsaved ?? null };
  const done = () =>
    finishWithNote(gate, {
      flush: async () => {
        calls.push("flush");
        if (state.fails) throw new Error("not saved");
      },
      unsaved: () => state.unsaved,
      stop: () => void calls.push("stop"),
      onUnsaved: () => void calls.push("ended unsaved"),
    });
  return { done, calls, state };
}

describe("Done with a note", () => {
  test("waits for the save, then stops", async () => {
    const { done, calls } = setup();
    expect(await done()).toBe("stopped");
    expect(calls).toEqual(["flush", "stop"]);
  });

  test("a rejected save keeps the recording going", async () => {
    const { done, calls } = setup({ fails: true, unsaved: "my note" });
    expect(await done()).toBe("blocked");
    expect(calls).toEqual(["flush"]);
  });

  test("Done again for the same unsaved text ends the recording and says so", async () => {
    const { done, calls } = setup({ fails: true, unsaved: "my note" });
    await done();
    expect(await done()).toBe("stopped");
    expect(calls).toEqual(["flush", "flush", "ended unsaved", "stop"]);
  });

  test("new unsaved text since the failure blocks again", async () => {
    const { done, state } = setup({ fails: true, unsaved: "my note" });
    await done();
    state.unsaved = "my note, more";
    expect(await done()).toBe("blocked");
  });

  test("a save that works after a failure stops without the acknowledgement", async () => {
    const { done, calls, state } = setup({ fails: true, unsaved: "my note" });
    await done();
    state.fails = false;
    expect(await done()).toBe("stopped");
    expect(calls.at(-1)).toBe("stop");
    expect(calls).not.toContain("ended unsaved");
  });
});
