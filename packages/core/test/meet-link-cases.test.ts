import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { meetingLinkFromInput } from "../src/index.js";

type Case = { input: string; outcome: "canonical" | "passthrough" | "reject"; canonical?: string };
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/meet-link-cases.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("meetingLinkFromInput shared Meet cases", () => {
  for (const { input, outcome, canonical } of cases) {
    test(`${outcome}: ${input}`, () => {
      const result = meetingLinkFromInput(input);
      if (outcome === "canonical") expect(result).toBe(canonical!);
      else if (outcome === "passthrough") expect(result).toBe(input);
      else expect(result === null || result === input).toBe(true);
    });
  }
});
