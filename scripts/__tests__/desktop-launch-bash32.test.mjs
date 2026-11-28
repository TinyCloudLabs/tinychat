import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(repo, rel), "utf8");

// TC-4459: the launch check runs on a macOS runner, whose /bin/bash is 3.2. It has no mapfile, readarray, associative
// arrays, case-changing expansions, `&>>`, `wait -n` or negative array indexes, and every one of them fails there at
// run time. The tests run on Linux with a current bash, so they never see it: this reads the text instead.
const BASH4_ONLY = [
  [/\bmapfile\b/, "mapfile"],
  [/\breadarray\b/, "readarray"],
  [/\b(?:declare|local|typeset)\s+-[a-zA-Z]*A/, "associative array"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(?:,,?|\^\^?)\}/, "case-changing expansion"],
  [/&>>/, "&>>"],
  [/\|&/, "|&"],
  [/\bwait\s+-n\b/, "wait -n"],
  [/\bcoproc\b/, "coproc"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[-\d+\]\}/, "negative array index"],
];

function runBlocks(workflow) {
  // Each `run: |` block, up to the next line indented no deeper than the `run:` key.
  const lines = workflow.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)run: \|\s*$/.exec(lines[i]);
    if (!match) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].startsWith(`${match[1]}  `)); j++) body.push(lines[j]);
    blocks.push(body.join("\n"));
  }
  return blocks;
}
const withoutComments = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("what runs on the macOS runner uses nothing that needs bash 4", () => {
  const checked = [
    ["scripts/release/desktop-launch-check.sh", withoutComments(read("scripts/release/desktop-launch-check.sh"))],
    ...runBlocks(read(".github/workflows/desktop-launch-check.yml")).map((block, index) => [`desktop-launch-check.yml run block ${index + 1}`, withoutComments(block)]),
    ...runBlocks(read(".github/workflows/desktop-launch-probe.yml")).map((block, index) => [`desktop-launch-probe.yml run block ${index + 1}`, withoutComments(block)]),
  ];
  assert.ok(checked.length >= 2, "expected the script and at least one run block");
  for (const [name, text] of checked) {
    for (const [pattern, what] of BASH4_ONLY) assert.doesNotMatch(text, pattern, `${name} uses ${what}, which macOS's bash 3.2 lacks`);
  }
});

test("the archive lookup in the launch job gives one path from find, with the shell the runner has", () => {
  const block = runBlocks(read(".github/workflows/desktop-launch-check.yml")).find((text) => text.includes("exo-build"));
  assert.ok(block, "launch run block");
  const lookup = block.slice(0, block.indexOf("scripts/release/desktop-launch-check.sh"));
  const dir = spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim();
  try {
    spawnSync("mkdir", ["-p", `${dir}/exo-build/x`]);
    spawnSync("touch", [`${dir}/exo-build/x/One.app.zip`]);
    const ran = spawnSync("bash", ["-e", "-c", `${lookup}\nprintf '%s' "\${zips[0]}"`], { encoding: "utf8", env: { PATH: process.env.PATH, RUNNER_TEMP: dir } });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, `${dir}/exo-build/x/One.app.zip`);
    spawnSync("touch", [`${dir}/exo-build/y.app.zip`]);
    const two = spawnSync("bash", ["-e", "-c", lookup], { encoding: "utf8", env: { PATH: process.env.PATH, RUNNER_TEMP: dir } });
    assert.equal(two.status, 1);
    assert.match(two.stdout, /Expected one \.app\.zip, found:/);
  } finally {
    spawnSync("rm", ["-rf", dir]);
  }
});

// The probe runs the reusable workflow a release calls, on a signed app that is already built, in pull request CI.
test("the probe calls the release's launch workflow in pull request CI and holds no environment, secret or write token", () => {
  const probe = read(".github/workflows/desktop-launch-probe.yml");
  const body = probe.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.match(body, /^on:\n {2}pull_request:\n {4}paths:\n(?: {6}- \S+\n)*? {6}- \.github\/workflows\/desktop-launch-check\.yml\n/m);
  assert.match(body, /\n {6}- scripts\/release\/desktop-launch-check\.sh\n/);
  assert.match(body, /\n {4}uses: \.\/\.github\/workflows\/desktop-launch-check\.yml\n/);
  assert.match(body, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(body, /^\s+environment:/m);
  assert.doesNotMatch(body, /secrets[.:]/);
  assert.doesNotMatch(body, /:\s*write\b/);
  assert.doesNotMatch(body, /pull_request_target/);
  assert.doesNotMatch(body, /run: [^\n]*\$\{\{/);
});
