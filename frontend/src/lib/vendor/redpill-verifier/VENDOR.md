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
(`X-Requested-With: XMLHttpRequest`) headers are sourced the same way the rest of
the frontend addresses the backend (`import.meta.env.VITE_BACKEND_URL` +
`SessionStore`, mirroring `frontend/src/lib/chatApi.ts`) — no hardcoded literal.

1. **`verify.ts` → `fetchSignature`** — URL changed from
   `${API_BASE}/v1/signature/{id}?model=...` to
   `${BACKEND_ORIGIN}/api/signature/{id}?model=...`, and the
   `Authorization: Bearer ${apiKey}` header dropped (the backend injects
   `REDPILL_API_KEY`). The `apiKey` param is now unused and kept only for
   signature compatibility. A module-level `BACKEND_ORIGIN` + `tinychatBackendHeaders`
   helper was added near the imports to support this.
2. **`verifiers/cloud-api.ts` → `checkGpu`** — NRAS `POST` URL changed from
   `NVIDIA_NRAS_URL` to `${BACKEND_ORIGIN}/api/nras-proxy` (CORS-blocked direct);
   `NVIDIA_NRAS_URL` dropped from the import and the same `BACKEND_ORIGIN` +
   `tinychatBackendHeaders` helper added near the imports.
3. **`verifiers/cloud-api.ts` → `checkTdxQuote`** — Phala TDX-verify `POST` URL
   changed from `PHALA_TDX_VERIFIER_URL` to `${BACKEND_ORIGIN}/api/phala-verify`
   (CORS-blocked direct); `PHALA_TDX_VERIFIER_URL` dropped from the import and the
   `...tinychatBackendHeaders(true)` (session bearer + CSRF) headers added, reusing
   the same `BACKEND_ORIGIN` + `tinychatBackendHeaders` helper.

Note: this vendored version's `checkGpu` decodes the NRAS JWT payload without
fetching NVIDIA's JWKS, so there is **no JWKS GET to redirect** in the source.
The backend still exposes `GET /api/nras-proxy/jwks` for a future upstream bump
that verifies the NRAS signature.

`API_BASE` is intentionally **not** rewritten: `fetchAttestation` and
`detectProvider` are public and continue to call `api.redpill.ai` directly.

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
