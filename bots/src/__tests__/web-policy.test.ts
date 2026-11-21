import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botLayout } from "../layout";
import { hostListed, listedHost, parseWebPolicy, readWebPolicy, webSettingsFile, writeWebPolicy } from "../web-policy";

describe("listed hosts", () => {
  test.each(["example.com", "Docs.Example.COM", " example.com. ", "a-b.example.co.uk", "xn--bcher-kva.example"])("accepts %p", input => {
    expect(listedHost(input)).toBe(input.trim().toLowerCase().replace(/\.$/, ""));
  });

  test.each([
    "localhost", "example", "127.0.0.1", "10.0.0.1", "1.2.3.4", "::1", "[::1]", "https://example.com", "example.com/path", "example.com:8080",
    "user@example.com", "exa mple.com", "-a.example.com", "a-.example.com", "a..example.com", ".example.com", "bücher.example", "exаmple.com",
    "a".repeat(64) + ".com", `${"a.".repeat(130)}com`, "", 5, null, {},
  ])("refuses %p", input => {
    expect(listedHost(input)).toBeUndefined();
  });
});

describe("shared places", () => {
  test.each(["github.io", "pages.dev", "blogspot.com", "co.uk", "com.au", "herokuapp.com", "Netlify.app"])("%p covers everyone who publishes there, so it cannot be listed", input => {
    expect(listedHost(input)).toBeUndefined();
    expect(parseWebPolicy({ mode: "listed", hosts: ["example.com", input] })).toBeUndefined();
  });

  test.each(["me.github.io", "docs.pages.dev", "example.co.uk", "bbc.co.uk", "co.example.com"])("one tenant's own name %p can be listed", input => {
    expect(listedHost(input)).toBe(input.toLowerCase());
  });
});

describe("policy parsing", () => {
  test("lowercases and de-duplicates a list, and clears hosts unless the mode is listed", () => {
    expect(parseWebPolicy({ mode: "listed", hosts: ["Example.com", "example.com", "docs.rs"] })).toEqual({ mode: "listed", hosts: ["example.com", "docs.rs"] });
    expect(parseWebPolicy({ mode: "any", hosts: ["example.com"] })).toEqual({ mode: "any", hosts: [] });
    expect(parseWebPolicy({ mode: "off", hosts: [] })).toEqual({ mode: "off", hosts: [] });
  });

  test("one bad entry refuses the whole setting, as do an unknown mode, a missing list and more than 50 sites", () => {
    expect(parseWebPolicy({ mode: "listed", hosts: ["example.com", "127.0.0.1"] })).toBeUndefined();
    expect(parseWebPolicy({ mode: "all", hosts: [] })).toBeUndefined();
    expect(parseWebPolicy({ mode: "listed" })).toBeUndefined();
    expect(parseWebPolicy({ mode: "listed", hosts: Array.from({ length: 51 }, (_, i) => `site${i}.example.com`) })).toBeUndefined();
    expect(parseWebPolicy({ mode: "listed", hosts: Array.from({ length: 50 }, (_, i) => `site${i}.example.com`) })?.hosts).toHaveLength(50);
    expect(parseWebPolicy(null)).toBeUndefined();
    expect(parseWebPolicy([])).toBeUndefined();
  });

  test("a listed site covers its subdomains and nothing that merely ends the same way", () => {
    const policy = { mode: "listed" as const, hosts: ["example.com"] };
    expect(hostListed(policy, "example.com")).toBe(true);
    expect(hostListed(policy, "DOCS.Example.com")).toBe(true);
    expect(hostListed(policy, "example.com.")).toBe(true);
    expect(hostListed(policy, "badexample.com")).toBe(false);
    expect(hostListed(policy, "example.com.evil.test")).toBe(false);
    expect(hostListed(policy, "example.org")).toBe(false);
  });
});

describe("saved setting", () => {
  const root = mkdtempSync(join(tmpdir(), "web-policy-"));
  const layout = botLayout("c".repeat(64), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
  mkdirSync(layout.dataDir, { recursive: true });

  test("round-trips; a missing file, junk, and a bad list all read as off", () => {
    expect(readWebPolicy(layout)).toEqual({ mode: "off", hosts: [] });
    writeWebPolicy(layout, { mode: "listed", hosts: ["docs.rs"] });
    expect(readWebPolicy(layout)).toEqual({ mode: "listed", hosts: ["docs.rs"] });
    writeFileSync(webSettingsFile(layout), "not json");
    expect(readWebPolicy(layout)).toEqual({ mode: "off", hosts: [] });
    writeFileSync(webSettingsFile(layout), JSON.stringify({ mode: "listed", hosts: ["127.0.0.1"] }));
    expect(readWebPolicy(layout)).toEqual({ mode: "off", hosts: [] });
    rmSync(root, { recursive: true, force: true });
  });
});
