import { describe, expect, test } from "bun:test";
import { runImportLoop } from "./importLoop";

describe("import loop storage rejection handling", () => {
  test("stops after the first storage rejection and marks remaining work canceled", async () => {
    const attempts: string[] = [];
    let progress = 0;
    const result = await runImportLoop(
      ["first", "second", "third"],
      async (item) => {
        attempts.push(item);
        throw { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage quota exceeded" };
      },
      () => false,
      () => { progress++; },
    );

    expect(attempts).toEqual(["first"]);
    expect(result.failures.map((failure) => failure.item)).toEqual(["first"]);
    expect(result.imported).toBe(0);
    expect(result.canceled).toBe(2);
    expect(progress).toBe(3);
  });

  test("ordinary per-item failures do not stop later imports", async () => {
    const attempts: string[] = [];
    const result = await runImportLoop(
      ["first", "second"],
      async (item) => {
        attempts.push(item);
        if (item === "first") throw new Error("invalid conversation");
      },
      () => false,
      () => {},
    );

    expect(attempts).toEqual(["first", "second"]);
    expect(result.failures.map((failure) => failure.item)).toEqual(["first"]);
    expect(result.imported).toBe(1);
    expect(result.canceled).toBe(0);
  });
});
