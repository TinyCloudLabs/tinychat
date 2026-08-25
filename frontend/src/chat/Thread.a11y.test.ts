import { expect, test } from "bun:test";

test("composer omits the persistent meeting-provider disclosure", async () => {
  const source = await Bun.file(new URL("./Thread.tsx", import.meta.url)).text();
  expect(source).not.toContain("meeting-provider-disclosure");
  expect(source).not.toContain(
    "Meeting questions send selected meeting text to the chosen inference provider.",
  );
});
