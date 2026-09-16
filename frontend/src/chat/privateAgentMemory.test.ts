import { describe, expect, test } from "bun:test";
import { privateMemoryContext, runPrivateMemoryExtraction } from "./privateAgentMemory";
import { MEMORY_TEMPLATE } from "../lib/memory";

describe("browser memory access", () => {
  test("inactive and unknown access inject no memory and perform no extraction operations", async () => {
    const access = { current: { active: false, revision: null, generation: 0 } };
    let operations = 0;
    expect(privateMemoryContext(access, "PRIVATE_MEMORY")).toBe("");
    await runPrivateMemoryExtraction(access, [{ role: "user", content: "hello" }], {
      getDoc: async () => { operations++; return "PRIVATE_MEMORY"; },
      complete: async () => { operations++; return "private response"; },
      setDoc: async () => { operations++; },
    });
    expect(operations).toBe(0);
  });
  test("a pending extraction cannot write or publish after access changes", async () => {
    const access = { current: { active: true, revision: "a", generation: 0 } };
    let finish!: (value: string) => void;
    let started!: () => void; const ready = new Promise<void>((done) => { started = done; });
    let writes = 0;
    const pending = runPrivateMemoryExtraction(access, [{ role: "user", content: "hello" }], {
      getDoc: async () => null,
      complete: () => { started(); return new Promise((done) => { finish = done; }); },
      setDoc: async () => { writes++; },
    });
    await ready;
    access.current = { active: true, revision: "b", generation: 2 };
    finish(MEMORY_TEMPLATE.replace("## Identity", "## Identity\nName: Alice"));
    await pending;
    expect(writes).toBe(0);
  });
});


test("an account change during a memory read prevents extraction inference", async () => {
  const access = { current: { active: true, revision: "same", generation: 0 } };
  let account = "original";
  let finish!: (doc: string) => void; let started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  let inference = 0; let writes = 0;
  const work = runPrivateMemoryExtraction(access, [{ role: "user", content: "old account text" }], {
    getDoc: () => { started(); return new Promise(done => { finish = done; }); },
    complete: async () => { inference++; return ""; }, setDoc: async () => { writes++; },
  }, () => account === "original");
  await ready; account = "new"; finish("old account memory"); await work;
  expect(inference).toBe(0); expect(writes).toBe(0);
});
