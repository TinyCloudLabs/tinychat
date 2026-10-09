import { describe, expect, test } from "bun:test";
import { createMomentFlow, type MomentField } from "./momentController";

function setup(mark: () => number | Promise<number>) {
  let md = "";
  const fields: (MomentField | null)[] = [];
  const errors: unknown[] = [];
  const flow = createMomentFlow(
    {
      markMoment: mark,
      readMd: () => md,
      writeMd: (next) => {
        md = next;
      },
      onError: (error) => errors.push(error),
    },
    (field) => fields.push(field),
  );
  return { flow, fields, errors, md: () => md, set: (v: string) => (md = v) };
}

describe("noting a moment", () => {
  test("stamps the time at the tap, not at the save", async () => {
    let now = 42_000;
    const t = setup(() => now);
    t.flow.begin();
    now = 61_000;
    t.flow.type("Hunter mentions the TTL");
    t.flow.commit();
    await t.flow.settled();
    expect(t.md()).toBe("- **0:42** Hunter mentions the TTL");
  });

  test("writes a bare bookmark at the tap and keeps it when the text is empty", async () => {
    const t = setup(() => 20_000);
    t.flow.begin();
    await t.flow.settled();
    expect(t.md()).toBe("- **0:20**");
    t.flow.commit();
    await t.flow.settled();
    expect(t.md()).toBe("- **0:20**");
  });

  test("cancel removes the line and leaves the rest of the note", async () => {
    const t = setup(() => 20_000);
    t.set("# Notes\nhello");
    t.flow.begin();
    t.flow.type("never mind");
    t.flow.cancel();
    await t.flow.settled();
    expect(t.md()).toBe("# Notes\nhello");
  });

  test("shows the time at once when the clock is synchronous", () => {
    const t = setup(() => 42_000);
    t.flow.begin();
    expect(t.fields.at(-1)).toEqual({ time: "0:42" });
    t.flow.commit();
    expect(t.fields.at(-1)).toBeNull();
  });

  test("an asynchronous clock opens the field first and fills in the time", async () => {
    let resolve!: (ms: number) => void;
    const t = setup(() => new Promise<number>((r) => (resolve = r)));
    t.flow.begin();
    expect(t.fields.at(-1)).toEqual({ time: null });
    t.flow.type("late answer");
    t.flow.commit();
    resolve(7_000);
    await t.flow.settled();
    expect(t.md()).toBe("- **0:07** late answer");
  });

  test("a second moment saves the first", async () => {
    let now = 5_000;
    const t = setup(() => now);
    t.flow.begin();
    t.flow.type("one");
    now = 9_000;
    t.flow.begin();
    t.flow.type("two");
    t.flow.commit();
    await t.flow.settled();
    expect(t.md()).toBe("- **0:05** one\n- **0:09** two");
  });

  test("a clock that fails closes the field and reports it", async () => {
    const boom = new Error("no clock");
    const t = setup(() => Promise.reject(boom));
    t.flow.begin();
    await t.flow.settled();
    expect(t.fields.at(-1)).toBeNull();
    expect(t.errors).toEqual([boom]);
    expect(t.md()).toBe("");
  });

  test("commit and cancel with nothing open do nothing", async () => {
    const t = setup(() => 1_000);
    t.flow.commit();
    t.flow.cancel();
    await t.flow.settled();
    expect(t.md()).toBe("");
  });
});
