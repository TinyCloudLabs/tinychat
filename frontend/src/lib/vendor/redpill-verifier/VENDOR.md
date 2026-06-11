# Vendored: @redpill-ai/verifier

This directory is a verbatim copy of the TypeScript source of
[`@redpill-ai/verifier`](https://github.com/redpill-ai/redpill-verifier),
which is not published to npm. The source lives in the `js/src` subdirectory of
that repository.

- **Source:** https://github.com/redpill-ai/redpill-verifier (`js/src`)
- **Vendored commit:** `f93cefd87eb55c92511c3ae0425665e409cedd15` (2026-04-16)
- **Upstream version:** 1.0.0
- **License:** MIT — "RedPill AI" (see LICENSE in this directory)

Only the library source (`js/src`) was copied. The upstream `bin/cli.ts`
(Node-only CLI) and build config were intentionally left out. The sole runtime
dependency is `viem`, already present in the frontend.

## Deviations from upstream

Upstream is a Node CLI that calls `api.redpill.ai`, NVIDIA NRAS, and Phala's
verifier directly with the API key in hand. In the browser, three of those calls
cannot be made directly (one needs the server-held key, two are CORS-blocked), so
**only those three fetch URLs** are redirected to our forge-proof backend
passthroughs. Every other line of verification logic is byte-identical to upstream
— the browser still does all ECDSA recovery and quote checks itself; the proxies
compute no verdict.

`BACKEND_ORIGIN` and the auth (`Authorization: Bearer <session>`) + CSRF
(`X-Requested-With: XMLHttpRequest`) headers are sourced from the same backend
origin and session-storage contract used by `frontend/src/lib/chatApi.ts`
(`import.meta.env.VITE_BACKEND_URL` plus the app session token) — no hardcoded
literal and no heavy TinyCloud SDK import inside the vendored browser helpers.

1. **`verify.ts` → `fetchSignature`** — URL changed from
   `${API_BASE}/v1/signature/{id}?model=...` to
   `${BACKEND_ORIGIN}/api/signature/{id}?model=...`, and the
   `Authorization: Bearer ${apiKey}` header dropped (the backend injects
   `REDPILL_API_KEY`). The `apiKey` param is now unused and kept only for
   signature compatibility. A module-level `BACKEND_ORIGIN` +
   `tinychatSessionToken` + `tinychatBackendHeaders` helper was added near the
   imports to support this.
2. **`verifiers/cloud-api.ts` → `checkGpu`** — NRAS `POST` URL changed from
   `NVIDIA_NRAS_URL` to `${BACKEND_ORIGIN}/api/nras-proxy` (CORS-blocked direct);
   the now-unused `NVIDIA_NRAS_URL` constant is removed, and the same
   `BACKEND_ORIGIN` + `tinychatSessionToken` + `tinychatBackendHeaders` helper is
   added near the imports.
3. **`verifiers/cloud-api.ts` → `checkTdxQuote`** — Phala TDX-verify `POST` URL
   changed from `PHALA_TDX_VERIFIER_URL` to `${BACKEND_ORIGIN}/api/phala-verify`
   (CORS-blocked direct); the now-unused `PHALA_TDX_VERIFIER_URL` constant is
   removed and the `...tinychatBackendHeaders(true)` (session bearer + CSRF)
   headers added, reusing the same `BACKEND_ORIGIN` + `tinychatSessionToken` +
   `tinychatBackendHeaders` helper.

4. **`verifiers/cloud-api.ts` → `checkGpu`** (ST5 GPU-JWT verification, deviation
   **(b)** per Hard Constraint 1; added in commit `fa4861c` — do NOT revert) — beyond
   the NRAS `POST` redirect above, `checkGpu` now verifies NVIDIA's ES384 signature on
   the NRAS token in-browser before trusting any claim. `fetchNrasJwks()` was added: it
   GETs `${BACKEND_ORIGIN}/api/nras-proxy/jwks` through the backend passthrough (the
   JWKS read is CORS-blocked from the browser, like the NRAS `POST`), and `verifyNrasJwt`
   (from `@/lib/nrasJwt`) checks the token's signature against those keys. The GPU
   verdict is forced to `'unverified-signature'` when the signature cannot be verified
   (`verdict = signatureVerified ? claimedVerdict : 'unverified-signature'`) — honest
   degradation, never a false PASS. Upstream's `checkGpu` decoded the JWT payload without
   signature verification; this deviation strengthens that trust check and must not be
   reverted (reverting violates constraint 2).

`API_BASE` is intentionally **not** rewritten: `fetchAttestation` and
`detectProvider` are public and continue to call `api.redpill.ai` directly.
Likewise `verify.ts`'s `fetchPhalaSystemInfo` intentionally calls
`cloud-api.phala.network/api/v1/apps/{appId}/attestations` **directly** (a public,
non-CORS-blocked read); only the Phala `.../attestations/verify` POST is proxied.

### Keeping the redirects across upstream bumps (ST12b)

Re-vendoring (copying upstream over this directory) silently reverts the three
redirects above. Two safety nets guard against that:

- **`scripts/apply-vendor-redirects.mjs`** — re-applies the three fetch-URL
  redirects idempotently. Run it after every re-vendor:
  `node scripts/apply-vendor-redirects.mjs`.
- **`frontend/src/lib/vendorRedirects.test.ts`** — fails loudly if any redirected
  fetch site reverts to a direct upstream URL.

## Consumer note (no package change)

The badge (`frontend/src/chat/ModelVerificationBadge.tsx`) no longer calls the
top-level `verify()`. `verify()` mandates a per-message signature and throws on
Tinfoil/Chutes models that don't sign replies. The badge instead composes its
verdict over `verifyModel({ model })` (attestation only) plus a local, graceful
`@/lib/signatureClient` (the per-message signature, returning `null` instead of
throwing when absent) — see `docs/two-tier-verification-plan.md`. This is a
consumer-side choice; the vendored `verify.ts` (including the forked
`fetchSignature`) is unchanged and still importable.

Import via the package entry point:

```ts
import { verifyModel, checkCompose /* ... */ } from "@/lib/vendor/redpill-verifier";
```

To update: re-clone upstream, copy `js/src/.` over this directory (excluding
this file and LICENSE), and bump the commit hash above.
