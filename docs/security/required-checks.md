# Required checks and the pre-release security gate

What has to be green before a change merges to `main` and before a commit ships to production, and the repository
settings that enforce it. The workflows and scripts in this repo do the checking; the ruleset and environment changes
below are applied by an org admin (Amos), never by a workflow. Secret scanning is gitleaks only (Sam, 2026-11-22): no
paid GitHub Secret Protection, and nothing here depends on GitHub push protection.

No agent merges with --admin or uses the ruleset bypass to pass red or pending checks, except a rollback on Naomi's word.

## The checks

| Check name (job) | Workflow | Runs on | Fails when |
| --- | --- | --- | --- |
| `Gitleaks` | `.github/workflows/gitleaks.yml` | every PR; every push to `main` | PR: a secret-shaped string in the PR's own commits, judged by the base commit's `.gitleaksignore` and `.gitleaks.toml` (default rules when absent) with inline `gitleaks:allow` ignored, so a PR cannot allowlist its own leak. `main`: any finding in the full history of `main` not in main's reviewed baseline (`.gitleaksignore`) or its `.gitleaks.toml` allowlist. A PR that changes the baseline, a gitleaks config or the workflow also scans its full head history with its own baseline and config. |
| `Backend and package tests` | `.github/workflows/backend.yml` | every PR; every push to `main` | the backend suite (auth, consent scope, CORS, exo-grant and the rest), the shared-package suites, the Home mirror tests or the Vector config fail. A PR that touches no backend path reports success without running them; `main` always runs them. |
| `Native sign-in request fits OpenKey's ceiling` | `.github/workflows/native-ceiling.yml` | every PR; every push to `main` | production OpenKey refuses the native sign-in request. Same skip rule as Backend. |
| `Frontend tests, lint and browser harnesses` | `.github/workflows/frontend.yml` | every PR; every push to `main` | frontend unit tests, lint, typecheck or the build fail. A PR whose `changes` job selects no frontend input reports success without running them; `main` always runs them. |
| `No unruled edits to existing tests` | `.github/workflows/test-edit-guard.yml` | every PR | a PR edits an existing test without a `test-ruling:` line. |
| `Changeset`, `Cloudflare Pages` | existing | every PR | unchanged (already required). |

The skip inside Backend, Native ceiling and Frontend fails open: Backend and Native ceiling skip the work only when
`git diff base...head` succeeds and lists no relevant path; Frontend skips it only when its `changes` job succeeds and
selects no frontend input. That keeps each job present on every PR, so it can be required.

The backend check runs the Main, sibling, legacy, and revoke bot-history network suites in separate Bun processes against a
digest-pinned TinyCloud node on loopback. The node uses fresh local state and must advertise named-key support;
all four suites must pass without skips. Run the same check locally with `.github/scripts/run-bot-history-network.sh`
after installing the workspace and bots dependencies and building the workspace packages. Details: TC-3968

### Release gates (`.github/workflows/deploy-production.yml`, every deploy, rollbacks and hotfixes included)

All of these run before anything changes in production; any failure deploys nothing.

1. **Web build audit** (`target`, web deploys only). A production build of the target commit, made the way the
   Cloudflare Pages production build makes it (`[env.production.vars]` from `wrangler.toml`, `CF_PAGES=1`,
   `build:packages`, `build:frontend`), then:
   - `scripts/release/audit-artifact.mjs --config .github/security/web-dist-audit.json`: no sourcemaps or
     `sourceMappingURL`, only listed file types, no symlinks or special files, and no credential-shaped string (Stripe
     live keys, PEM blocks, unreviewed 32-byte hex, Slack, JWT, AWS, GitHub and npm tokens). The 36 reviewed 32-byte
     hex constants are public curve and library constants (@noble/curves, ethers, viem), each listed by sha256 with
     its source. Output names the rule and file, never the value.
   - `gitleaks dir --max-archive-depth 2` with `.github/security/gitleaks-web-dist.toml` (default rules, plus exact
     allowlists for the `ROUTE_UNAVAILABLE_HEADER=` identifier and, at run time, the public OpenKey native client id
     read from `frontend/.env.production`).
   Audit code and policy come from `main`; only the build comes from the target commit.
2. **Release gate** (`target`, every deploy): `scripts/release/require-green.mjs` waits (up to 40 minutes) until
   `Gitleaks`, `Backend and package tests`, `Native sign-in request fits OpenKey's ceiling` and
   `Frontend tests, lint and browser harnesses` are `success` on the commit being shipped (GitHub Actions runs only;
   the newest run of each name decides; skipped, cancelled or missing fails). A stable tag sits on the Release
   workflow's `[skip ci]` version commit; the gate then checks its parent, and only if the version commit changes
   release metadata alone (changesets, changelogs, `version` fields). A release from before the gate (an ancestor of
   the parent of the first `main` commit that added `require-green.mjs`, and an ancestor of `main`) never ran these
   checks on push, so it deploys without them and the log says `pre-gate release: checks not required`; this keeps
   rollbacks to earlier releases possible. Every later commit needs them green, and a commit off `main` never
   qualifies.
3. **Backend image scan** (`deploy-backend-phala.yml`): build, scan, then push. trivy 0.76.2 scans the built image
   before it is pushed, `--severity CRITICAL,HIGH --ignore-unfixed`, against the reviewed `.trivyignore` from the
   workflow commit. Any fixable HIGH or CRITICAL not in the baseline fails the deploy, and nothing reaches GHCR
   (neither the commit tag nor `:latest`) or the CVM. `build-images.yml` (manual seeding of a new CVM) still pushes
   unscanned images, `:latest` included; the production deploy never reads `:latest` (it pins the commit tag).

gitleaks 8.30.1 and trivy 0.76.2 are installed by `.github/scripts/install-security-tool.sh`, pinned by version and
sha256. A missing tool, a checksum mismatch or an API error fails the job.

## Ruleset change: `main: release PRs only` (id 25069687)

Apply each new context only after that check has passed once on `main` (Naomi's rule). Confirm with:

```sh
gh api "repos/TinyCloudLabs/tinychat/commits/$(gh api repos/TinyCloudLabs/tinychat/commits/main --jq .sha)/check-runs?filter=all&per_page=100" \
  --jq '.check_runs[] | select(.app.id == 15368) | "\(.name): \(.conclusion)"' | sort -u
```

Before (current `required_status_checks` rule, strict off):

```json
[{ "context": "Changeset" }, { "context": "Cloudflare Pages" }]
```

After (new contexts pinned to the GitHub Actions app, 15368, so no other app or status can satisfy them):

```json
[
  { "context": "Changeset" },
  { "context": "Cloudflare Pages" },
  { "context": "Gitleaks", "integration_id": 15368 },
  { "context": "Backend and package tests", "integration_id": 15368 },
  { "context": "Native sign-in request fits OpenKey's ceiling", "integration_id": 15368 },
  { "context": "Frontend tests, lint and browser harnesses", "integration_id": 15368 },
  { "context": "No unruled edits to existing tests", "integration_id": 15368 }
]
```

Apply (everything else in the ruleset, bypass actors included, stays as it is):

```sh
R=repos/TinyCloudLabs/tinychat/rulesets/25069687
dir=$(mktemp -d)
gh api "$R" | jq '{name, target, enforcement, conditions, bypass_actors, rules}' > "$dir/before.json"
jq '.rules |= map(if .type == "required_status_checks" then .parameters.required_status_checks += [
      {context: "Gitleaks", integration_id: 15368},
      {context: "Backend and package tests", integration_id: 15368},
      {context: "Native sign-in request fits OpenKey'"'"'s ceiling", integration_id: 15368},
      {context: "Frontend tests, lint and browser harnesses", integration_id: 15368},
      {context: "No unruled edits to existing tests", integration_id: 15368}
    ] else . end)' "$dir/before.json" > "$dir/after.json"
diff <(jq -S . "$dir/before.json") <(jq -S . "$dir/after.json")   # only the five contexts are added
gh api -X PUT "$R" --input "$dir/after.json"
```

Undo: `gh api -X PUT "$R" --input "$dir/before.json"`.

Bypass actors stay as they are (Sam, 2026-11-22: "Keep the bypass"): the `OrganizationAdmin` `always` bypass is
neither removed nor narrowed, and the `DeployKey` bypass stays for the Release workflow's pushes over the
release-push deploy key. The rule at the top of this document governs its use.

## Deploy secrets: environments only (Naomi's ruling, 2026-11-22)

Deploy tokens live only in environments limited to `main`, and nothing that runs for a pull request or a preview gets
one. This repo's main-only environments are `production-api` (backend), `production-bots` (bots) and `release-push`
(release tags, `production` branch); each has a single `main` branch policy (`production-bots` also has required
reviewers). Pull requests and Pages previews are build-only today: no PR workflow references a deploy secret, and
Pages preview builds run in Cloudflare's git integration with no GitHub token.

The gap: the secrets below are **repository** secrets, which a workflow run on any branch of this repo can read (a
branch push with an edited workflow is enough). Each is read only by a production deploy job that already declares a
main-only environment, so the move needs no workflow change: once an environment copy exists, the job reads it in
preference to the repository copy.

Every step below happens only on Naomi's GO, and Amos executes it. No value is ever printed, pasted or compared in
the clear; only the first 8 hex characters of a sha256.

### 1. `CONNECTOR_CREDENTIAL_MASTER` (first)

- Repository secret, last set 2026-09-29. The connector credential custody master: the backend encrypts and decrypts
  stored connector credentials with it (calendar autojoin's Google credentials included,
  `docker-compose.phala.yml`). Losing it makes every stored connector credential unreadable.
- Used by: `deploy-backend-phala.yml`, job `deploy` (writes it into the CVM's encrypted env). No other workflow.
- Environment already declared: yes, `deploy` runs in `production-api`.
- Move to: `production-api`.
- **STOP rule:** if step 1 finds no copy outside GitHub, or the copy found does not match the live value (step 3's
  check run against the repository copy), stop. Naomi decides. Never delete the only copy.
- **Status (2026-11-22): step 1 found no recoverable copy outside GitHub.**
  - The repository secret cannot be read back: GitHub does not export a secret.
  - The backend CVM holds a sealed copy (`allowed_envs`, `docker-compose.phala.yml`). Every backend deploy rewrites
    the CVM's encrypted env from the repository secret, so that copy is not a backup. Reading the value out of the
    CVM would be an export.
  - No inventory records another copy.

  **Backup gap:** with no copy outside GitHub, losing or overwriting the repository secret loses the key that unwraps
  every stored connector credential. Rotation is ruled out: it orphans existing envelopes (calendar autojoin's Google
  credentials among them).

  **Plan (TC-3895):**
  1. A one-off workflow on `main` copies the value one time into the owner's TinyCloud Secrets. Security reviews that
     workflow, and it prints no value.
  2. The GitHub copy then goes from repository secrets into the `production-api` environment with the move steps
     below, starting at step 2. The TinyCloud Secrets copy is the source of truth for steps 2 and 3.

### 2. The other repository secrets read only by production deploy jobs

All are read in the `deploy` job of `deploy-backend-phala.yml` (environment `production-api`, declared), which passes
them into the backend CVM's encrypted env. `PHALA_CLOUD_API_KEY` and `CERTBOT_EMAIL` are also read by the `deploy`
job of `deploy-bots-phala.yml` (environment `production-bots`, declared). No other workflow reads any of them.

| Secret | Last set | Used for | Move to | Hash proof |
| --- | --- | --- | --- | --- |
| `BACKEND_PRIVATE_KEY` | 2026-06-03 | backend signing key | `production-api` | yes |
| `STRIPE_SECRET_KEY` | 2026-07-22 | Stripe API | `production-api` | yes |
| `STRIPE_WEBHOOK_SECRET` | 2026-06-05 | Stripe webhook signatures | `production-api` | yes |
| `WEBHOOK_HMAC_MASTER` | 2026-08-12 | connector webhook HMAC master | `production-api` | yes |
| `LEDGER_SERVICE_SECRET` | 2026-07-21 | backend to ledger service auth | `production-api` | yes |
| `ELIZA_SERVICE_SECRET` | 2026-06-22 | backend to Eliza service auth | `production-api` | yes |
| `LOG_HASH_SALT` | 2026-08-12 | log identifier hashing | `production-api` | yes |
| `GOOGLE_OAUTH_CLIENT_SECRET` | 2026-08-18 | Google OAuth (Meet, calendar) | `production-api` | yes |
| `ASSEMBLYAI_API_KEY` | 2026-10-04 | transcription provider | `production-api` | yes |
| `ASSEMBLYAI_HOSTED_HANDLE_KEY` | 2026-10-04 | hosted transcription handles | `production-api` | yes |
| `TRANSCRIPTION_API_KEY` | 2026-08-19 | transcription service | `production-api` | yes |
| `TRANSCRIPTION_WEBHOOK_SECRET` | 2026-10-13 | transcription webhooks | `production-api` | yes |
| `REDPILL_API_KEY` | 2026-06-02 | model API | `production-api` | yes |
| `PHALA_CLOUD_API_KEY` | 2026-10-13 | Phala Cloud API (CVM deploys) | `production-api` and `production-bots` | yes |
| `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` | 2026-06-05, 2026-06-05, 2026-09-17, 2026-06-05 | Stripe price ids (config) | `production-api` | yes |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_REDIRECT_URI` | 2026-08-18 | public OAuth client id and URL (config) | `production-api` | low entropy* |
| `GOOGLE_MEET_OAUTH_ENABLED`, `PAYWALL_ENABLED` | 2026-08-18, 2026-06-05 | feature flags (config) | `production-api` | low entropy* |
| `CERTBOT_EMAIL` | 2026-06-03 | TLS certificate contact (config) | `production-api` and `production-bots` | low entropy* |

\* A hash prefix of a guessable value (a flag, a public id or URL, an email address) gives the value away to anyone
who can read the job log. For these, compare the prefix in the run and do not copy it anywhere else, or skip step 3
and rely on step 4.

### Move steps (per secret, in table order, `CONNECTOR_CREDENTIAL_MASTER` first)

1. **Find its source of truth outside GitHub** (password manager, provider console, the system that issued it).
   GitHub cannot export a secret. Record where it is, never what it is.
2. **Set the environment copy** from that source:
   `gh secret set <NAME> --repo TinyCloudLabs/tinychat --env production-api` (and `--env production-bots` for
   `PHALA_CLOUD_API_KEY` and `CERTBOT_EMAIL`), value on stdin, never on the command line.
3. **Prove a hash-prefix match.** In a job running in the production environment, compute
   `printf '%s' "$VALUE" | sha256sum | cut -c1-8` (no trailing newline) and compare it with the same computation on
   the source. Run it once before step 2 as well: then the job reads the repository copy, which proves the source
   matches what production runs today. After step 2 it reads the environment copy. Both must match the source. The job
   needs a one-off workflow on `main` (a separate PR at Naomi's GO, removed afterwards), because a main-only
   environment runs only from `main`:

   ```yaml
   name: Secret fingerprints (one-off)
   on:
     workflow_dispatch:
       inputs:
         environment: { type: choice, options: [production-api, production-bots] }
   permissions: {}
   jobs:
     fingerprints:
       runs-on: ubuntu-latest
       environment: ${{ inputs.environment }}
       steps:
         - name: sha256 prefixes (8 hex) only
           env:
             CONNECTOR_CREDENTIAL_MASTER: ${{ secrets.CONNECTOR_CREDENTIAL_MASTER }}
             # ...one line per secret in the table above
           run: |
             for name in CONNECTOR_CREDENTIAL_MASTER; do  # same list
               value="${!name}"
               if [ -z "$value" ]; then echo "$name: unset"; else echo "$name: $(printf '%s' "$value" | sha256sum | cut -c1-8)"; fi
             done
   ```
4. **Run a green deploy that reads the environment copy:** `deploy-production.yml` with `backend=true` for
   `production-api` (its health check proves the backend came up with the values); `deploy-bots-phala.yml` for
   `production-bots`.
5. **Delete the repository copy:** `gh secret delete <NAME> --repo TinyCloudLabs/tinychat`, only after steps 1 to 4
   passed for that secret. Check `gh secret list --repo TinyCloudLabs/tinychat` no longer lists it.
6. **Undo.** After step 2: `gh secret delete <NAME> --repo TinyCloudLabs/tinychat --env production-api` (the
   repository copy is still there and takes over again). After step 5: re-create the repository copy from the source
   (`gh secret set <NAME> --repo TinyCloudLabs/tinychat`), prove it with step 3, then delete the environment copy if
   wanted.

Before: the 24 secrets above are repository secrets. After: each exists only in the environment(s) in its row.

### Repository secrets no workflow on `main` references

- `QA_MAIL_ADDRESS_SECRET`, `QA_MAIL_READ_TOKEN` (both set 2026-11-22). Both are for the TinyChat embed gate (branch
  `qa/embed-gate-tinychat`). Its job declares a main-only environment, proposed name `qa-embed-gate`. When that
  workflow lands on `main`, both go into that environment with the move steps above (step 4 is that workflow's first
  green run on `main`), and the repository copies are deleted. Their source of truth is qa-mail.

Org secrets visible to this repository that no workflow here reads: `NPM_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (the latter
also exists in `release-push`, which is what `deploy-production.yml` reads). Removing tinychat from `NPM_TOKEN`'s
selected repositories closes that path (undo: add it back).

## Baselines

### `.gitleaksignore` (84 fingerprints over the full history of `main` to `4ce3e190` and open-branch commits)

Every entry was read in place. None is a live credential; each is a test fixture, a public identifier or code. No
fixture value appears outside tests and harness screens. Line numbers are those of the fingerprinted commit. Two
entries are commits that open branches carry and `main` does not hold (the pre-squash history of a merged PR, and a
branch's own commit): `asks-gateway.test.ts:245` (31c85e56) and `secret-grants.test.ts:294` (4e7dfe4b).

| File:line | Rule | Why it is safe |
| --- | --- | --- |
| `frontend/.env.production:12` | generic-api-key | OpenKey native OAuth client id: a public client identifier, shipped in every native sign-in request. |
| `backend/src/services/transcript-delivery.ts:44` | generic-api-key | A key-name prefix constant, not a value. |
| `frontend/src/harness/screens/botView.tsx:72` | generic-api-key | A React `key` prop in harness UI. |
| `frontend/src/harness/screens/homeFeedDetails.tsx:14` | generic-api-key | A `did:key` (public key) in harness data. |
| `frontend/src/lib/renewalReceipt.fixture.ts:8,9,10` | generic-api-key | `did:key` test identifiers (public keys). |
| `log-shipper/vector.tests.yaml:236` | jwt | Dummy HS256 JWT (`{"sub":"123456"}`) that the redaction test checks is stripped. |
| `scripts/release/ios-signing.sh:44` | private-key | The literal `BEGIN PRIVATE KEY` marker in parsing code, no key material. |
| `backend/src/__tests__/fixtures/mcp-native-grant.json:3,7` | generic-api-key, jwt | Captured test delegation from the js-sdk hermetic node, signed by a test key for the well-known private-key-1 address (`0x7e5f…`); expired 2026-10-28. |
| `backend/src/__tests__/connector-observability.test.ts:751`, `backend/src/__tests__/webhook-tokens.test.ts:1464` | stripe-access-token | `sk_live_` placeholder with a synthetic body, used to prove redaction. |
| `frontend/src/lib/imageUrlFilter.corpus.test.ts:102` | aws-access-token | Synthetic `AKIA` id in a URL-filter corpus. |
| `backend/src/__tests__/chat-gating.test.ts:21`, `chat-relay-signature.test.ts:36`, `frontend/src/chat/verification-predicates.test.ts:246,247` | generic-api-key | The public Hardhat/anvil development key. |
| `backend/src/__tests__/` `assemblyai-hosted-alerts:52`, `assemblyai-hosted:44`, `auth-session:255,269,286,296,315`, `connector-content-store:64`, `connector-credentials:43`, `connector-observability:85`, `connector-teardown:60`, `consent-scope:64`, `granola-proxy-hardening:19,493`, `index-wiring:463,834`, `mcp-grant-real-sdk:87`, `private-cloud-transcription:45`, `rate-limits-bot-send:4`, `request-record:26,34`, `webhook-verify:10` (`.test.ts`) | generic-api-key | Test constants declared in the test: `did:key` ids (public keys), made-up handle, tenant, master and HMAC keys the test passes to the code under test, `grn_` and `0123456789…` placeholder keys, and redaction canaries. |
| `bots-regular/src/__tests__/regular.test.ts:10`, `bots-regular/src/__tests__/role-prompt.test.ts:5`, `bots-regular/src/__tests__/omp-config.test.ts:9`, `bots/src/__tests__/role.test.ts:11`, `backend/src/__tests__/bot-history-sibling-routes.test.ts:130`, `packages/server/src/__tests__/delegation-store.test.ts:386,403,440` | generic-api-key | Placeholder key and storage-path strings (`0123456789…`, `delegations/0x…`). |
| `bots/src/__tests__/asks-gateway.test.ts:245,258` | generic-api-key | A made-up `SECRET-QUESTION-…` canary the logging test checks never appears in a log line. |
| `scripts/__tests__/release.test.mjs:1119,1518` | generic-api-key | Fake Apple signing env: Apple's documentation example issuer id and `ABCDE12345`-style placeholders. |
| `frontend/src/` `apps/embedHost.test.ts:11,13`, `apps/ledgerCeiling.test.ts:20`, `bots/botChatApi.test.ts:19`, `bots/botPath.test.ts:12`, `bots/historyRestoredSession.sdk.test.ts:28`, `chat/RegistrySection.test.tsx:31,32,33`, `lib/connectors/serverCredentialTeardownRetry.test.ts:32`, `lib/debugLog.test.ts:20,50`, `lib/firstPartySignIn.sdk.test.ts:27`, `lib/homeReauthorize.sdk.test.tsx:35`, `lib/registryEditor/adapter.test.ts:25,26`, `lib/replication/readOnlyAccountProvider.sdk.test.ts:26`, `lib/sessionGrants.sdk.test.tsx:33`, `lib/webConnectorsGrant.sdk.test.tsx:37`; `frontend/test-fixtures/ConnectorDialog.granolaS4.fixture.tsx:20,21`; `bots/src/__tests__/secret-grants.test.ts:294` | generic-api-key | Test fixtures: `did:key` ids and placeholder keys. |

Adding an entry: confirm the finding is not live (anything possibly live goes to security and is rotated, never
listed). Baseline changes go in their own PR, merged before the PR that adds the fixture (PRs are judged by their
base commit's baseline). List a new fixture as `file:rule:line` without the commit, since a squash merge changes it.

### `.gitleaks.toml` allowlist

The default rules apply, with one allowlist for two fixture classes the generic-api-key rule flags in tests. A finding
is allowlisted only when both hold:

- the file is a test file or test fixture (`__tests__/`, `test-fixtures/` or a name ending `.test.ts`, `.test.tsx`
  or `.test.mjs`);
- the whole secret is a `did:key` Ed25519 identifier (`z6Mk` and 44 base58 characters, a public key) or
  `0123456789abcdef` repeated (a placeholder).

Over the full history of `main` to `704ed01f` the allowlist covers 36 of the findings the baseline lists, each one
reviewed as one of these two classes. Those baseline entries stay. A change to the allowlist is a security
review like a baseline change, in its own PR.

Limit: `pull_request` runs the workflow file from the PR, so a PR that edits `.github/workflows/gitleaks.yml` can
change its own scan. Review workflow edits as code that holds the gate.

### `.trivyignore` (82 vulnerability ids, backend image)

Recorded against the production image of `@tinychat/backend@0.9.5`. All are fixable and ship today; the baseline only
stops them from blocking the deploy and makes any new one fail it. 5 CRITICAL: `perl-base` (3), `proxy-addr` (1) and
the Go standard library inside the esbuild binary (1); 77 HIGH across Debian base packages
and npm packages. The image also ships development dependencies (vite, happy-dom, esbuild, launch-editor,
browserslist, postcss), which account for part of the list. Remove an entry when the image no longer has it.
