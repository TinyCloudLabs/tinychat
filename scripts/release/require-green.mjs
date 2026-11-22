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
// Pre-gate releases: a commit from before this gate existed never ran its checks on push. It is accepted without
// them ("pre-gate release: checks not required") only when it is an ancestor of the first-parent predecessor of the
// gate commit (the first commit on main's first-parent history that added this file) AND an ancestor of main. Every
// later commit needs its checks green; a commit off main never qualifies.
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

const gitIn = (cwd) => (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const isAncestor = (git, ancestor, descendant) => {
  try {
    git("merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};

export const GATE_FILE = "scripts/release/require-green.mjs";

// True when `commit` predates the gate on main (see the header). Throws when the gate commit cannot be found.
export function isPreGateCommit(commit, { cwd = process.cwd(), mainRef = "refs/remotes/origin/main" } = {}) {
  const git = gitIn(cwd);
  const gate = git("log", "--first-parent", "--diff-filter=A", "--format=%H", mainRef, "--", GATE_FILE).split("\n").filter(Boolean).at(-1);
  if (!gate) throw new Error(`cannot find the commit that added ${GATE_FILE} on ${mainRef}`);
  const parents = git("rev-list", "--parents", "-n", "1", gate).split(" ").slice(1);
  if (parents.length === 0) return false;
  return isAncestor(git, commit, parents[0]) && isAncestor(git, commit, mainRef);
}

// The commit whose CI vouches for `sha`: itself, or the parent of a release-metadata-only [skip ci] commit.
export function testedCommit(sha, { cwd = process.cwd(), log = console.log } = {}) {
  const git = gitIn(cwd);
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
    log(`${commit.slice(0, 12)} is a release version commit ([skip ci], metadata only); checking its parent`);
    commit = parents[0];
  }
  throw new Error(`more than 3 [skip ci] commits above ${sha}`);
}

const ghCheckRuns = (repo, commit) =>
  JSON.parse(
    execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repo}/commits/${commit}/check-runs?filter=all&per_page=100`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

// Resolves when the deploy may proceed; throws otherwise.
export async function requireGreen({
  sha,
  repo,
  cwd = process.cwd(),
  mainRef = "refs/remotes/origin/main",
  timeoutMs = 40 * 60_000,
  intervalMs = 30_000,
  fetchCheckRuns = ghCheckRuns,
  log = console.log,
}) {
  const commit = testedCommit(sha, { cwd, log });
  if (isPreGateCommit(commit, { cwd, mainRef })) {
    log(`${commit}: pre-gate release: checks not required`);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { state, lines } = evaluateChecks(await fetchCheckRuns(repo, commit), commit);
    log(`Required checks on ${commit} (${new Date().toISOString()}):\n  ${lines.join("\n  ")}`);
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

function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

async function main(argv) {
  const sha = argument(argv, "--sha");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !repo) throw new Error("usage: GITHUB_REPOSITORY=o/r require-green.mjs --sha <40-hex>");
  await requireGreen({
    sha,
    repo,
    timeoutMs: Number(argument(argv, "--timeout-minutes", "40")) * 60_000,
    intervalMs: Number(argument(argv, "--interval-seconds", "30")) * 1000,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error title=Release gate::${error.message}`);
    process.exit(1);
  });
}
