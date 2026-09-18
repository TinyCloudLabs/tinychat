# Releasing TinyChat's retrieval skill

TinyChat owns `agent-skills/tinychat-retrieval`. The CLI core skill is released independently by `@tinycloud/cli`. The first setup pairs CLI 0.10.0, retrieval 0.1.0 and the existing skills installer 1.7.0. Public URLs are not considered available until anonymously verified after deployment.

## Build and check

```sh
bun install --frozen-lockfile
bun run test:agent-skills
bun test frontend/src/chat/AgentSetupCard.test.tsx frontend/src/chat/AgentEnablementBanner.test.tsx
bun run build:packages
bun run build:frontend
```

`frontend`'s build generates the pack and public page before Vite copies the static files. No backend, inference-service or connector deployment is needed. The helper runs on plain Node; Bun is a development/test dependency.

The build includes only SKILL.md, pack.json, lib, scripts, assets and references. Test fixtures and local environment files are excluded. The versioned directory contains a portable npm-shaped archive, directly readable source files and `release.json` with SHA-256 hashes. Existing version directories are immutable: unchanged sources reuse the verified stored archive; changed sources require a new version. This permits different npm gzip metadata on subsequent machines without changing release bytes. Keep earlier committed version directories when releasing updates.

Before committing a new release, synchronize the helper's `PACK_VERSION`, `pack.json`, skill metadata, and `frontend/src/lib/agent-setup.json`. Update the public page's CLI minimum only after that CLI is publicly obtainable. Public page source is in `agent-setup/`; its prompt comes from the same JSON file used by the product's Settings card. Do not hand-edit generated files.

## Publish using existing Pages infrastructure

Push the reviewed TinyChat branch and inspect the existing Cloudflare Pages check. Confirm the branch preview's static `/agents/` page, `/agents/setup.md`, every referenced Markdown/JSON file and the archive. Check content bytes, content types and hashes; a 200 response containing the SPA is a failed artifact check. `/agents/*` is routed before the app fallback. Mutable setup routes use revalidation; identified artifacts use immutable caching.

Use the repository's normal reviewed main deployment for the public site. The Settings action and the exact public prompt must resolve the identified artifacts without sign-in. Recheck the npm CLI archive and all public app URLs anonymously, with empty npm configurations and no repository credentials. Public artifact access is separate from consent to private data.

Run the documented `skills@1.7.0 add` commands in a disposable home to prove complete copying, repeat installation, version update/removal and preservation of unrelated settings. Archive installation is not tracked by automatic `skills update`; install the new explicit version URL.

## Acceptance and scope

The development workspace tracks per-client acceptance separately in `docs/tinycloud-cli-skills-retrieval-acceptance.md` and its JSON ledger. Local helper tests, packaged synthetic login, preview availability and public same-account tests are different gates. Each of OpenCode, Codex and Claude Code requires a fresh first-use and return session, using the same published versions and exact public prompt. The human completes existing-identity consent. Never seed the tested agent with developer paths, schema hints or copied grants.

The first pack discovers SQL-indexed legacy meetings. KV-only and backend-only catalogs are excluded and disclosed in every coverage envelope. Legacy body hashes do not certify an atomic SQL/KV snapshot. Node SQL scope confinement remains separately unverified for the hosted runtime; do not describe fixed queries or client tool permissions as server enforcement. Keep any security reproduction details private.
