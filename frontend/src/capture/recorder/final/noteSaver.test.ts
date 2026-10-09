import { describe, expect, test } from "bun:test";
import { createNoteSaver } from "./noteSaver";
import type { NoteStatus } from "./notesApiStub";

function setup(
  status: NoteStatus,
  opts: { unsaved?: string | null; fail?: boolean } = {},
) {
  const committed: string[] = [];
  const errors: unknown[] = [];
  const state = { fail: opts.fail ?? false };
  const saver = createNoteSaver({
    commit: async (md) => {
      committed.push(md);
      if (state.fail) throw new Error("write refused");
    },
    delayMs: 1_000_000,
    unsaved: opts.unsaved ?? null,
    status,
    onPending: () => {},
    onError: (error) => errors.push(error),
  });
  return { saver, committed, errors, state };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createNoteSaver", () => {
  test("a keystroke before the note is ready neither calls setNoteText nor drops the text", async () => {
    const { saver, committed } = setup("loading");
    saver.change("first words");
    saver.flush();
    await settle();
    expect(committed).toEqual([]);
    expect(saver.unsaved).toBe("first words");
  });

  test("the text typed while loading is committed once the note is ready", async () => {
    const { saver, committed } = setup("loading");
    saver.change("typed early");
    saver.setStatus("ready");
    saver.flush();
    await settle();
    expect(committed).toEqual(["typed early"]);
    expect(saver.unsaved).toBeNull();
  });

  test("an error status never commits, and the text stays", async () => {
    const { saver, committed } = setup("error");
    saver.change("kept");
    saver.flush();
    await settle();
    expect(committed).toEqual([]);
    expect(saver.unsaved).toBe("kept");
  });

  test("a draft carried over a layout switch is committed when the note is ready", async () => {
    const { saver, committed } = setup("loading", {
      unsaved: "from the sheet",
    });
    saver.setStatus("ready");
    saver.flush();
    await settle();
    expect(committed).toEqual(["from the sheet"]);
  });

  test("a rejected write is reported, keeps the text, and is retried only by the next flush", async () => {
    const { saver, committed, errors, state } = setup("ready", { fail: true });
    saver.change("draft");
    saver.flush();
    await settle();
    expect(committed).toEqual(["draft"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("write refused");
    expect(saver.unsaved).toBe("draft");
    await settle();
    expect(committed).toEqual(["draft"]);

    state.fail = false;
    saver.flush();
    await settle();
    expect(committed).toEqual(["draft", "draft"]);
    expect(errors.at(-1)).toBeNull();
    expect(saver.unsaved).toBeNull();
  });

  test("text typed while a write is in flight is not marked saved", async () => {
    const { saver, committed } = setup("ready");
    saver.change("a");
    saver.flush();
    saver.change("ab");
    await settle();
    expect(saver.unsaved).toBe("ab");
    saver.flush();
    await settle();
    expect(committed).toEqual(["a", "ab"]);
    expect(saver.unsaved).toBeNull();
  });
});
