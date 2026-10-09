import { describe, expect, test } from "bun:test";
import { createAutosave } from "./autosave";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createAutosave", () => {
  test("saves the last value once, after the delay", async () => {
    const saved: string[] = [];
    const pending: boolean[] = [];
    const autosave = createAutosave(
      (v) => saved.push(v),
      20,
      (p) => pending.push(p),
    );
    autosave.schedule("a");
    autosave.schedule("ab");
    expect(saved).toEqual([]);
    expect(autosave.pending).toBe(true);
    await wait(50);
    expect(saved).toEqual(["ab"]);
    expect(autosave.pending).toBe(false);
    expect(pending.at(-1)).toBe(false);
  });

  test("flush saves at once and the timer then does nothing", async () => {
    const saved: string[] = [];
    const autosave = createAutosave((v) => saved.push(v), 20);
    autosave.schedule("x");
    autosave.flush();
    expect(saved).toEqual(["x"]);
    await wait(50);
    expect(saved).toEqual(["x"]);
  });

  test("flush with nothing waiting saves nothing", () => {
    const saved: string[] = [];
    createAutosave((v) => saved.push(v), 20).flush();
    expect(saved).toEqual([]);
  });
});
