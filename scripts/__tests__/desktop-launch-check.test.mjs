import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(repo, rel), "utf8");
const code = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

// The launch check runs the app that was built from the project, so it must not hold anything the sign job holds.
test("the launch check job has no environment, no secret and a read-only token, and tooling is its only checkout", () => {
  const workflow = code(read(".github/workflows/desktop-launch-check.yml"));
  assert.match(workflow, /^on:\n {2}workflow_call:/m);
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(workflow, /^\s+environment:/m);
  assert.doesNotMatch(workflow, /secrets[.:]/);
  assert.doesNotMatch(workflow, /^\s+permissions:\n\s+\S+: write/m);
  assert.match(workflow, /runs-on: macos-26/);
  const checkouts = workflow.match(/uses: actions\/checkout@/g) ?? [];
  assert.equal(checkouts.length, 1);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}\n\s+sparse-checkout: \|\n\s+\/scripts\/release\/\n\s+sparse-checkout-cone-mode: false\n\s+persist-credentials: false/);
  assert.deepEqual(workflow.match(/\S*scripts\/release\/desktop-\S+/g), ["scripts/release/desktop-launch-check.sh"]);
  // Inputs reach the script as environment, never interpolated into it.
  assert.doesNotMatch(workflow, /run: [^\n]*\$\{\{ inputs\./);
  const script = workflow.slice(workflow.indexOf("name: Launch the app and read its page"), workflow.indexOf("name: Keep the screenshot"));
  assert.doesNotMatch(script.slice(script.indexOf("run: |")), /\$\{\{/);
});

test("a release publishes only after the launch check passes, for signed and unsigned builds alike", () => {
  const release = read(".github/workflows/desktop-release.yml");
  const launch = release.slice(release.indexOf("\n  launch:\n"), release.indexOf("\n  publish:\n"));
  assert.match(launch, /needs: \[plan, build\]\n\s+uses: \.\/\.github\/workflows\/desktop-launch-check\.yml\n/);
  assert.match(launch, /artifact-name: exo-\$\{\{ needs\.plan\.outputs\.version \}\}-macos-arm64\n/);
  assert.match(launch, /version: \$\{\{ needs\.build\.outputs\.version \}\}\n/);
  assert.match(launch, /bundle-version: \$\{\{ needs\.build\.outputs\.bundle-version \}\}\n/);
  assert.match(launch, /signed: \$\{\{ needs\.plan\.outputs\.signing == 'required' \}\}/);
  assert.doesNotMatch(launch, /secrets:|environment:|\sif:/);
  assert.match(release, /\n {2}publish:\n {4}name: Publish\n {4}needs: \[plan, build, launch\]\n/);
});

// The refusals that run before the app is touched: they also run where there is no macOS.
function check(args) {
  const dir = mkdtempSync(join(tmpdir(), "launch-check-"));
  try {
    writeFileSync(join(dir, "app.zip"), "");
    const resolved = args.map((arg) => arg.replace("<zip>", join(dir, "app.zip")));
    return spawnSync("bash", [join(repo, "scripts/release/desktop-launch-check.sh"), ...resolved, join(dir, "work")], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the launch check refuses a missing archive, a bad mode, a bad version and a bad build number", () => {
  const cases = [
    [["/nonexistent/app.zip", "0.22.12", "2212999", "signed"], /::error::no archive at \/nonexistent\/app\.zip/],
    [["<zip>", "0.22.12", "2212999", "maybe"], /::error::mode is 'maybe', expected signed or unsigned/],
    [["<zip>", "latest", "2212999", "signed"], /::error::version 'latest' is not X\.Y\.Z/],
    [["<zip>", "0.22.12", "22.12", "signed"], /::error::build number '22\.12' is not digits/],
  ];
  for (const [args, message] of cases) {
    const result = check(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, message);
  }
  for (const args of [["<zip>", "0.22.12"], ["<zip>", "0.22.12", "", "signed"]]) assert.notEqual(check(args).status, 0, args.join(" "));
});
