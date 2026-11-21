import { expect, test } from "bun:test";

import { MAX_CHOICE, MAX_QUESTION, isDeclinedReply, plainText } from "./askText";

test("control, bidirectional and zero-width characters never reach the card", () => {
  const hostile = "pay\u202Eknab\u202C\u2066x\u2069 now\u0000\u0007\u001b[31m\u200b\u200e\u061c\ufeff\u2028done\u0085";
  const shown = plainText(hostile, MAX_QUESTION);
  expect(shown).toBe("pay knab x now [31m done");
  // The same ranges as before, checked by code point so the test source holds no control characters in a regex.
  const banned: Array<[number, number]> = [[0x0, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
  const leaked = [...shown].filter(ch => banned.some(([lo, hi]) => ch.codePointAt(0)! >= lo && ch.codePointAt(0)! <= hi));
  expect(leaked).toEqual([]);
});

test("a line break in a question becomes a space, so a quote stays one paragraph", () => {
  expect(plainText("one\ntwo\r\n\r\nthree\tfour", MAX_QUESTION)).toBe("one two three four");
});

test("links, markup and Markdown stay as the characters they are", () => {
  const text = "See [x](https://evil.test/a) <img src=\"https://evil.test/p.png\"> https://evil.test/bare ![i](https://evil.test/i.png)";
  expect(plainText(text, MAX_QUESTION)).toBe(text);
});

test("text is cut at the limit by characters, not by code units, and says so", () => {
  const long = "🙂".repeat(MAX_CHOICE + 10);
  const cut = plainText(long, MAX_CHOICE);
  expect([...cut]).toHaveLength(MAX_CHOICE);
  expect(cut.endsWith("…")).toBe(true);
  expect(plainText("short", MAX_CHOICE)).toBe("short");
});

test("only the service's not-now message is recognized as a decline", () => {
  expect(isDeclinedReply("The person chose not to answer now. Carry on without it.")).toBe(true);
  expect(isDeclinedReply("The person answered your question: no")).toBe(false);
});
