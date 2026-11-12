---
"@tinychat/backend": patch
---

Require a pinned content-master commitment and successful existing-index decrypt before canary enrollment; verify the encrypted canary before ingestion starts. Add an authenticated read-only continuity diagnostic. Existing ingestion deployments must pin CONNECTOR_CONTENT_EXPECTED_SHA256 from their live master before first startup; fresh installations require explicit CONNECTOR_CONTENT_ENROLL_FRESH=true enrollment.

Take the ingest singleton lease before enrollment and reject blank pins. Require encoded random key material for new enrollment. An unset master permits startup only with empty sealed storage, leaves sealed features disabled, and returns a diagnostic error without a fingerprint.

Close connections that become idle after an in-flight response finishes during shutdown, so Bun shutdown does not wait for keep-alive expiry. Tighten base64 padding validation and limit the diagnostic exemption to its literal path.
