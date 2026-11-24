import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPrompts } from "../../scripts/build-agent-surface.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the prompts checkout is the pinned commit, and a name that resolves elsewhere is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-surface-checkout-"));
  roots.push(root);
  const repo = join(root, "prompts");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, "guide.md"), "pinned\n");
  git("add", "guide.md");
  git("commit", "--quiet", "-m", "pinned");
  const pinned = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "guide.md"), "other\n");
  git("commit", "--quiet", "-am", "other");
  git("tag", "release");

  checkoutPrompts(join(root, "good"), repo, pinned);
  expect(readFileSync(join(root, "good", "guide.md"), "utf8")).toBe("pinned\n");

  expect(() => checkoutPrompts(join(root, "named"), repo, "release")).toThrow("not the pinned commit release");
});
