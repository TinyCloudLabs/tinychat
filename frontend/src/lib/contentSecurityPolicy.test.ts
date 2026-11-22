import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

// The Content-Security-Policy lives in two places (TC-3878): the `/*` header in public/_headers, for the web, and the
// <meta http-equiv> in index.html, which is the only copy that reaches the phone apps (they load the bundle from the
// device). The header's other policy line is frame-ancestors, which a meta tag cannot carry. The inline script in
// index.html is allowed by its hash, so editing the script without the hash would stop it from running under the
// policy, on the phone first.

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const headersFile = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");

/** The bodies of the inline scripts (those without a src), exactly as the browser hashes them. */
function inlineScripts(source: string): string[] {
  return [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

/** The Content-Security-Policy lines of the `/*` block of _headers: Pages joins them, and a browser enforces each. */
function headerLines(): string[] {
  const lines = headersFile.split("\n");
  const start = lines.findIndex((line) => line === "/*");
  expect(start).toBeGreaterThanOrEqual(0);
  const policies: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^\s+Content-Security-Policy:\s*(.+)$/.exec(line);
    if (match) policies.push(match[1]!.trim());
  }
  return policies;
}

/** The header's content policy: the line that is not the frame-ancestors one. */
function headerPolicy(): string {
  const policies = headerLines().filter((policy) => policy !== "frame-ancestors 'self'");
  expect(policies).toHaveLength(1);
  return policies[0]!;
}

/** The policy index.html's meta tag carries. */
function metaPolicy(): string {
  const tags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/g)];
  expect(tags).toHaveLength(1);
  return tags[0]![1]!.trim();
}

function directives(policy: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      expect(parsed.has(name)).toBe(false);
      parsed.set(name, sources);
    }
  }
  return parsed;
}

describe("Content-Security-Policy", () => {
  const scripts = inlineScripts(html);

  test("index.html has exactly one inline script, which the policy would have to name", () => {
    expect(scripts).toHaveLength(1);
  });

  test("the header and the meta tag both allow the inline script by its current hash", () => {
    const hash = `'sha256-${createHash("sha256").update(scripts[0]!).digest("base64")}'`;
    expect(directives(headerPolicy()).get("script-src")).toContain(hash);
    expect(directives(metaPolicy()).get("script-src")).toContain(hash);
  });

  test("the header and the meta tag carry the same policy, and the header keeps frame-ancestors on its own line", () => {
    expect(headerLines()).toContain("frame-ancestors 'self'");
    expect(headerPolicy()).toBe(metaPolicy());
    expect(directives(metaPolicy()).has("frame-ancestors")).toBe(false);
  });

  test("scripts run only from this origin, the inline hash and WebAssembly", () => {
    for (const policy of [headerPolicy(), metaPolicy()]) {
      const parsed = directives(policy);
      const scriptSrc = parsed.get("script-src")!;
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).toContain("'wasm-unsafe-eval'");
      expect(scriptSrc.filter((source) => !["'self'", "'wasm-unsafe-eval'"].includes(source) && !source.startsWith("'sha256-"))).toEqual([]);
      expect(parsed.get("default-src")).toEqual(["'self'"]);
      expect(parsed.get("object-src")).toEqual(["'none'"]);
      expect(parsed.get("base-uri")).toEqual(["'self'"]);
    }
  });
});
