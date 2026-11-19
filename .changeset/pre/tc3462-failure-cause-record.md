---
"@tinychat/backend": patch
---

Record why a chat stream failed (TC-3462). A `tinychat_request` record whose stream ended in `error` now carries `failure_cause`: `model` when the model's own output broke the reply (the charged causes in `docs/credits.md`), otherwise `ours`. It is recorded from the stream terminal, so it is present with paywall gating off, and the log shipper allowlist passes only `model` or `ours`. No ledger change.
