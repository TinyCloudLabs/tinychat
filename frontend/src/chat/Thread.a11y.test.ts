import { expect, test } from "bun:test";

test("composer associates the meeting-provider disclosure for assistive technology", async () => {
  const source = await Bun.file(new URL("./Thread.tsx", import.meta.url)).text();
  expect(source).toContain('aria-describedby="meeting-provider-disclosure"');
  expect(source).toContain('id="meeting-provider-disclosure"');
});
