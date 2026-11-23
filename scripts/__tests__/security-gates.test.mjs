import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditArtifact, sha256 } from "../release/audit-artifact.mjs";
import { REQUIRED_CHECKS, evaluateChecks, isReleaseMetadataDiff, requireGreen } from "../release/require-green.mjs";

const SHA = "a".repeat(40);
const run = (id, name, status, conclusion, extra = {}) => ({ id, name, status, conclusion, head_sha: SHA, app: { id: 15368 }, ...extra });
const state = (runs, names = ["A", "B"]) => evaluateChecks([{ total_count: runs.length, check_runs: runs }], SHA, names).state;

// main: pre → version ([skip ci], metadata only) → gate (adds require-green.mjs) → post; side branches off pre.
function gateRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "require-green-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const commit = (message, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const pre = commit("feat: pre-gate work", { "backend/package.json": '{\n  "version": "0.9.4"\n}\n' });
  const version = commit("chore(release): stable versions [skip ci]", { "backend/package.json": '{\n  "version": "0.9.5"\n}\n' });
  const gate = commit("ci: gate", { "scripts/release/require-green.mjs": "// gate\n" });
  const post = commit("feat: post-gate work", { "backend/src/a.ts": "export {};\n" });
  git("update-ref", "refs/remotes/origin/main", post);
  git("checkout", "-q", "-b", "side", pre);
  const side = commit("feat: never merged", { "backend/src/b.ts": "export {};\n" });
  return { root, pre, version, gate, post, side };
}

async function gateOutcome(root, sha) {
  const logs = [];
  let fetched = 0;
  const fetchCheckRuns = () => {
    fetched += 1;
    return [{ total_count: 0, check_runs: [] }];
  };
  try {
    await requireGreen({ sha, repo: "o/r", cwd: root, timeoutMs: 0, intervalMs: 1, fetchCheckRuns, log: (line) => logs.push(line) });
    return { passed: true, fetched, logs: logs.join("\n") };
  } catch (error) {
    return { passed: false, fetched, logs: logs.join("\n"), error: error.message };
  }
}

test("require-green: a pre-gate release on main deploys without checks", async (t) => {
  const { root, pre, version } = gateRepo(t);
  for (const sha of [version, pre]) {
    const outcome = await gateOutcome(root, sha);
    assert.equal(outcome.passed, true, outcome.error);
    assert.equal(outcome.fetched, 0);
    assert.match(outcome.logs, /pre-gate release: checks not required/);
  }
});

test("require-green: the gate commit and later commits with no check runs fail", async (t) => {
  const { root, gate, post } = gateRepo(t);
  for (const sha of [gate, post]) {
    const outcome = await gateOutcome(root, sha);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.fetched, 1);
    assert.match(outcome.error, /not all green in time/);
  }
});

test("require-green: a commit off main never counts as pre-gate", async (t) => {
  const { root, side } = gateRepo(t);
  const outcome = await gateOutcome(root, side);
  assert.equal(outcome.passed, false);
  assert.doesNotMatch(outcome.logs, /pre-gate/);
});

test("require-green: a post-gate commit with every required check green deploys", async (t) => {
  const { root, post } = gateRepo(t);
  const runs = REQUIRED_CHECKS.map((name, i) => ({ ...run(i + 1, name, "completed", "success"), head_sha: post }));
  await requireGreen({ sha: post, repo: "o/r", cwd: root, timeoutMs: 0, fetchCheckRuns: () => [{ total_count: runs.length, check_runs: runs }], log: () => {} });
});

test("require-green: the newest run of each required check decides", () => {
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "completed", "success")]), "success");
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "completed", "failure"), run(3, "B", "completed", "success")]), "success");
  assert.equal(state([run(3, "A", "completed", "failure"), run(1, "A", "completed", "success"), run(2, "B", "completed", "success")]), "failure");
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "completed", "skipped")]), "failure");
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "completed", "cancelled")]), "failure");
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "in_progress", null)]), "pending");
});

test("require-green: runs from another app or another commit do not count", () => {
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "completed", "success", { app: { id: 1 } })]), "pending");
  assert.equal(state([run(1, "A", "completed", "success"), run(2, "B", "completed", "success", { head_sha: "b".repeat(40) })]), "pending");
});

test("require-green: an incomplete check-run listing fails closed", () => {
  assert.throws(() => evaluateChecks([{ total_count: 3, check_runs: [run(1, "A", "completed", "success")] }], SHA, ["A"]));
  assert.throws(() => evaluateChecks([], SHA, ["A"]));
});

test("require-green: only a release-metadata diff stands in for its parent", () => {
  const bump = '-  "version": "0.9.5-beta.1",\n+  "version": "0.9.5",\n-version = "0.9.5-beta.1"\n+version = "0.9.5"';
  assert.equal(isReleaseMetadataDiff([".changeset/pre.json", "backend/CHANGELOG.md", "backend/package.json", "desktop/src-tauri/Cargo.lock"], bump), true);
  assert.equal(isReleaseMetadataDiff(["backend/package.json"], `${bump}\n+    "left-pad": "1.0.0",`), false);
  assert.equal(isReleaseMetadataDiff([".changeset/pre.json", "backend/src/index.ts"], ""), false);
  assert.equal(isReleaseMetadataDiff([], ""), false);
});

test("audit-artifact: fails on sourcemaps, unlisted types, links and unreviewed credential shapes", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-artifact-"));
  try {
    const constant = `0x${"f".repeat(64)}`;
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "ok.js"), `const n=BigInt("${constant}");`);
    writeFileSync(join(root, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    const policy = {
      allowedExtensions: [".js", ".txt"],
      allowedExtensionlessNames: ["_headers"],
      reviewedMatches: [{ rule: "hex-32-bytes", sha256: sha256(constant), reason: "test constant" }],
    };
    assert.deepEqual(auditArtifact(root, policy).problems, []);

    writeFileSync(join(root, "assets", "bad.js"), `const k="sk_${"live"}_${"x".repeat(24)}";\n//# sourceMappingURL=bad.js.map`);
    writeFileSync(join(root, "assets", "bad.js.map"), "{}");
    writeFileSync(join(root, "run.exe"), "");
    symlinkSync("/etc/hostname", join(root, "link.txt"));
    const problems = auditArtifact(root, policy).problems.join("\n");
    for (const expected of ["bad.js: sourceMappingURL", "bad.js: stripe-live", "bad.js.map: sourcemap file", "run.exe: file type", "link.txt: not a regular file"]) {
      assert.match(problems, new RegExp(expected.replace(/\./g, "\\.")));
    }
    assert.doesNotMatch(problems, /x{24}/, "a matched value never reaches the output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
