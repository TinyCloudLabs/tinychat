import { expect, test } from "bun:test";
import { audienceCopy, displayOptions, optionText } from "./cardKit";

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

test("the thread helper names who actually receives a message, and never counts held recipients", () => {
  expect(audienceCopy({ approved: ["Mail agent"], fallback: "x" })).toEqual({ ask: "Ask Mail agent something", helper: "Only Mail agent sees this." });
  expect(audienceCopy({ approved: ["A", "B"], fallback: "x" }).helper).toBe("Only A and B see this.");
  expect(audienceCopy({ approved: ["A", "B", "C"], fallback: "x" })).toEqual({ ask: "Ask the agents on this card something", helper: "Only the 3 agents on this card see this." });
  expect(audienceCopy({ approved: ["A"], held: ["H"], fallback: "x" }).helper).toBe("Only A sees this. H isn't connected yet, so it doesn't get it.");
  expect(audienceCopy({ approved: [], held: ["H", "J"], fallback: "Owner" })).toEqual({ ask: "Ask Owner something", helper: "Only you see this for now. H and J aren't connected yet, so they don't get it." });
});
