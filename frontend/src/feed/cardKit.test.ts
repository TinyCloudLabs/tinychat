import { expect, test } from "bun:test";
import { displayOptions, optionText } from "./cardKit";

const options = [{ id: "yes", label: "Yes: node caches too (Recommended)" }, { id: "no", label: "No: client cache only" }];

test("a trailing (Recommended) marker comes off the label and marks that option suggested", () => {
  expect(displayOptions(options)).toEqual({ options: [{ id: "yes", label: "Yes: node caches too" }, { id: "no", label: "No: client cache only" }], suggested: "yes" });
  expect(optionText("Ship it  ( recommended )")).toBe("Ship it  ( recommended )");
  expect(optionText("Ship it (RECOMMENDED) ")).toBe("Ship it");
});

test("the card's own recommendation wins over a marker in a label", () => {
  expect(displayOptions(options, "no").suggested).toBe("no");
});

test("a marker mid-label is text, not a recommendation", () => {
  expect(displayOptions([{ id: "a", label: "(Recommended) by the old plan, now dropped" }]).suggested).toBeUndefined();
});
