import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditArtifact, sha256 } from "../release/audit-artifact.mjs";
import { evaluateChecks, isReleaseMetadataDiff } from "../release/require-green.mjs";

const SHA = "a".repeat(40);
const run = (id, name, status, conclusion, extra = {}) => ({ id, name, status, conclusion, head_sha: SHA, app: { id: 15368 }, ...extra });
const state = (runs, names = ["A", "B"]) => evaluateChecks([{ total_count: runs.length, check_runs: runs }], SHA, names).state;

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
