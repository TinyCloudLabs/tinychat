import { describe, expect, test } from "bun:test";
import { createNoteSaver } from "./noteSaver";
import type { RecorderNoteStatus } from "../voiceNoteRecorderController";

function setup(
  status: RecorderNoteStatus,
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
    await saver.flush().catch(() => {});
    expect(committed).toEqual([]);
    expect(saver.unsaved).toBe("first words");
  });

  test("flushing text the note cannot take rejects and reports, so Done cannot pass silently", async () => {
    const { saver, errors } = setup("loading");
    saver.change("typed early");
    await expect(saver.flush()).rejects.toThrow("not ready");
    expect(errors).toHaveLength(1);
  });

  test("the text typed while loading is committed once the note is ready", async () => {
    const { saver, committed } = setup("loading");
    saver.change("typed early");
    saver.setStatus("ready");
    await saver.flush();
    expect(committed).toEqual(["typed early"]);
    expect(saver.unsaved).toBeNull();
  });

  test("an error status never commits, and the text stays", async () => {
    const { saver, committed } = setup("error");
    saver.change("kept");
    await saver.flush().catch(() => {});
    expect(committed).toEqual([]);
    expect(saver.unsaved).toBe("kept");
  });

  test("a draft carried over a layout switch is committed when the note is ready", async () => {
    const { saver, committed } = setup("loading", {
      unsaved: "from the sheet",
    });
    saver.setStatus("ready");
    await saver.flush();
    expect(committed).toEqual(["from the sheet"]);
  });

  test("a rejected write rejects the flush, is reported, keeps the text, and is retried only by the next flush", async () => {
    const { saver, committed, errors, state } = setup("ready", { fail: true });
    saver.change("draft");
    await expect(saver.flush()).rejects.toThrow("write refused");
    expect(committed).toEqual(["draft"]);
    expect(errors).toHaveLength(1);
    expect(saver.unsaved).toBe("draft");
    await settle();
    expect(committed).toEqual(["draft"]);

    state.fail = false;
    await saver.flush();
    expect(committed).toEqual(["draft", "draft"]);
    expect(errors.at(-1)).toBeNull();
    expect(saver.unsaved).toBeNull();
  });

  test("a flush with nothing unsaved resolves", async () => {
    const { saver, committed } = setup("ready");
    await saver.flush();
    expect(committed).toEqual([]);
  });

  test("a flush while the same text is in flight waits for that write instead of repeating it", async () => {
    const { saver, committed } = setup("ready");
    saver.change("a");
    const first = saver.flush();
    const second = saver.flush();
    await Promise.all([first, second]);
    expect(committed).toEqual(["a"]);
  });

  test("text typed while a write is in flight is not marked saved", async () => {
    const { saver, committed } = setup("ready");
    saver.change("a");
    const first = saver.flush();
    saver.change("ab");
    await first;
    expect(saver.unsaved).toBe("ab");
    await saver.flush();
    expect(committed).toEqual(["a", "ab"]);
    expect(saver.unsaved).toBeNull();
  });

  test("the pause after a keystroke commits it without a flush", async () => {
    const committed: string[] = [];
    const saver = createNoteSaver({
      commit: async (md) => void committed.push(md),
      delayMs: 5,
      unsaved: null,
      status: "ready",
      onPending: () => {},
      onError: () => {},
    });
    saver.change("typed");
    expect(committed).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(committed).toEqual(["typed"]);
  });

  test("cancel stops the pause without writing", async () => {
    const committed: string[] = [];
    const saver = createNoteSaver({
      commit: async (md) => void committed.push(md),
      delayMs: 5,
      unsaved: null,
      status: "ready",
      onPending: () => {},
      onError: () => {},
    });
    saver.change("typed");
    saver.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(committed).toEqual([]);
  });
});
