# Exo Mac Google OAuth

## Summary

- Open consent in the system browser through Tauri opener. A one-shot Rust listener binds `127.0.0.1:0` before the browser opens, validates path, Host, state and callback shape, and times out after five minutes. The existing authenticated backend exchange receives the code and PKCE verifier.
- Use a separate Google **Desktop app** OAuth client for the ephemeral loopback redirect. The backend accepts only `http://127.0.0.1:<port>/oauth/google`, requires S256 PKCE, and routes later refreshes to that client. The phone `GOOGLE_OAUTH_NATIVE_RETURN` deep-link gate remains off.
- Keep the web popup flow. If blocked, offer **Open in this tab**, preserving the verifier in tab storage and returning only to the pinned app origin. Show browser progress, Cancel, timeout and errors.

## Required Google and deployment setup

1. In the **same Google Cloud project** as the existing OAuth consent screen, open **Google Auth Platform → Clients → Create client**. Select application type **Desktop app** and name it `Exo Mac`. Google supports ephemeral `127.0.0.1` loopback ports for this type; there is no fixed redirect URI to enter. Leave the existing Web application client and backend callback unchanged.
2. Add the new client ID as the repository Actions secret `GOOGLE_OAUTH_DESKTOP_CLIENT_ID` (or set that environment variable for a local backend), then deploy the backend. The workflow and Compose file pass it through. The desktop UI reports a configuration error until it is set. A Desktop client secret is not needed.
3. The existing consent screen's Meet, Drive metadata and Docs scopes must cover this client. A real Google consent round trip remains unverified until the client ID is configured.

Calendar autojoin setup on Mac is presented as web-only. Ordinary Google Meet connection and sync use the new desktop flow.

## Verification

- Frontend and backend `tsc --noEmit`: passed.
- Focused backend/frontend OAuth and connector tests: 169 passed.
- Rust `cargo test --lib google_oauth --no-default-features`: 2 passed (state mismatch, one-shot, timeout).
- Default-feature `cargo test --lib google_oauth`: 2 passed.
- Recorder Cargo tests: 30 passed (fixtures and fake devices; no real mic or speakers).

## In-flight PR overlap

PRs #350 and #351 also touch `desktop/src-tauri/src/lib.rs`, `build.rs` and/or `Cargo.lock`. Amos should sequence merges and reconcile those additions. No overlap with #348's changed files.

No GitHub comments or reviews were posted. Amos merges this PR.
