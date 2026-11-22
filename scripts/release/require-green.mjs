#!/usr/bin/env node
// Release gate (deploy-production.yml `target`): fails unless every check the deploy requires is `success` on the
// exact commit being shipped.
//
//   node scripts/release/require-green.mjs --sha <full SHA> [--timeout-minutes 40] [--interval-seconds 30]
//
// The stable tag sits on the Release workflow's version commit, which carries [skip ci], so CI never runs on it.
// That commit is accepted in place of its parent only when its diff is release metadata alone (changesets,
// changelogs and version fields; isReleaseMetadataDiff), and the checks are then required on the parent, whose tree
// is the one CI tested apart from those files. Any other [skip ci] commit fails the gate.
//
// Check runs come from `gh api --paginate --slurp repos/<repo>/commits/<sha>/check-runs?filter=all` (GH_TOKEN with
// checks: read). Only GitHub Actions runs on that exact SHA count; for each name the newest run (highest id) decides:
// success passes, any other completed conclusion fails, unfinished or missing waits until the deadline, then fails.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Check names: the job names of the workflows that run on every push to main. Keep in step with
// docs/security/required-checks.md.
export const REQUIRED_CHECKS = [
  "Gitleaks",
  "Backend and package tests",
  "Native sign-in request fits OpenKey's ceiling",
  "Frontend tests, lint and browser harnesses",
];
export const GITHUB_ACTIONS_APP_ID = 15368;

const METADATA_PATH = /^(?:\.changeset\/.+|(?:.+\/)?CHANGELOG\.md|(?:.+\/)?package\.json|desktop\/src-tauri\/Cargo\.(?:toml|lock))$/;
const VERSION_LINE = /^[+-](?:\s*"version": "[^"]*",?|version = "[^"]*")$/;

// files: changed paths; patch: `git diff -U0` of the package.json and Cargo files among them.
export function isReleaseMetadataDiff(files, patch) {
  if (files.length === 0 || !files.every((file) => METADATA_PATH.test(file))) return false;
  return patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line))
    .every((line) => VERSION_LINE.test(line));
}

// pages: the --slurp output. Returns { state: "success" | "failure" | "pending", lines }.
export function evaluateChecks(pages, sha, names = REQUIRED_CHECKS) {
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.some((page) => !Array.isArray(page?.check_runs) || !Number.isInteger(page.total_count) || page.total_count < 0)
  ) {
    throw new Error("Incomplete check-run response");
  }
  const checks = pages.flatMap((page) => page.check_runs);
  if (pages.some((page) => checks.length < page.total_count)) throw new Error("Incomplete check-run response");
  const lines = [];
  let failed = false;
  let pending = false;
  for (const name of names) {
    let newest;
    for (const check of checks) {
      if (check.name !== name || check.head_sha !== sha || check.app?.id !== GITHUB_ACTIONS_APP_ID) continue;
      if (!Number.isSafeInteger(check.id) || check.id <= 0) throw new Error(`Invalid check-run id for ${name}`);
      if (!newest || check.id > newest.id) newest = check;
    }
    if (!newest) {
      pending = true;
      lines.push(`missing  ${name}`);
    } else if (newest.status !== "completed") {
      pending = true;
      lines.push(`${newest.status.padEnd(8)} ${name} ${newest.html_url ?? ""}`);
    } else if (newest.conclusion === "success") {
      lines.push(`success  ${name} ${newest.html_url ?? ""}`);
    } else {
      failed = true;
      lines.push(`FAILED   ${name}: ${newest.conclusion} ${newest.html_url ?? ""}`);
    }
  }
  return { state: failed ? "failure" : pending ? "pending" : "success", lines };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// The commit whose CI vouches for `sha`: itself, or the parent of a release-metadata-only [skip ci] commit.
function testedCommit(sha) {
  let commit = sha;
  for (let hop = 0; hop < 3; hop += 1) {
    if (!/\[skip ci\]/i.test(git("log", "-1", "--format=%B", commit))) return commit;
    const parents = git("rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
    if (parents.length !== 1) throw new Error(`${commit} skips CI and is not a single-parent version commit`);
    const files = git("diff", "--no-renames", "--name-only", parents[0], commit).split("\n").filter(Boolean);
    const versioned = files.filter((file) => /(?:^|\/)package\.json$|Cargo\.(?:toml|lock)$/.test(file));
    const patch = versioned.length > 0 ? git("diff", "-U0", "--no-renames", parents[0], commit, "--", ...versioned) : "";
    if (!isReleaseMetadataDiff(files, patch)) {
      throw new Error(`${commit} skips CI and changes more than release metadata; CI never tested it`);
    }
    console.log(`${commit.slice(0, 12)} is a release version commit ([skip ci], metadata only); checking its parent`);
    commit = parents[0];
  }
  throw new Error(`more than 3 [skip ci] commits above ${sha}`);
}

function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

async function main(argv) {
  const sha = argument(argv, "--sha");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !repo) throw new Error("usage: GITHUB_REPOSITORY=o/r require-green.mjs --sha <40-hex>");
  const timeoutMs = Number(argument(argv, "--timeout-minutes", "40")) * 60_000;
  const intervalMs = Number(argument(argv, "--interval-seconds", "30")) * 1000;
  const commit = testedCommit(sha);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repo}/commits/${commit}/check-runs?filter=all&per_page=100`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const { state, lines } = evaluateChecks(JSON.parse(raw), commit);
    console.log(`Required checks on ${commit} (${new Date().toISOString()}):\n  ${lines.join("\n  ")}`);
    if (state === "success") return;
    if (state === "failure") {
      throw new Error(
        `a required check did not pass on ${commit}. Fix it on main and release again, or re-run the failed job on ` +
          `that commit if it was cancelled or flaky, then dispatch the deploy again.`,
      );
    }
    if (Date.now() + intervalMs > deadline) throw new Error(`required checks on ${commit} were not all green in time`);
    await sleep(intervalMs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error title=Release gate::${error.message}`);
    process.exit(1);
  });
}
