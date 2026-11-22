import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// public/_headers is what Cloudflare Pages serves with every static response, the app's pages included.
const sections = new Map<string, string[]>();
let current = "";
for (const line of readFileSync(new URL("../public/_headers", import.meta.url), "utf8").split("\n")) {
  if (line.trim() === "" || line.startsWith("#")) continue;
  if (!line.startsWith(" ")) { current = line.trim(); sections.set(current, []); continue; }
  sections.get(current)!.push(line.trim());
}

test("every page and file sends frame-ancestors 'self', so no other site can frame TinyCloud One (TC-3547)", () => {
  expect(sections.get("/*")).toContain("Content-Security-Policy: frame-ancestors 'self'");
});
