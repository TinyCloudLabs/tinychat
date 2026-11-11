---
"@tinychat/backend": patch
---

Require a pinned content-master commitment and successful existing-index decrypt before canary enrollment; verify the encrypted canary before ingestion starts. Add an authenticated read-only continuity diagnostic. Existing ingestion deployments must pin CONNECTOR_CONTENT_EXPECTED_SHA256 from their live master before first startup; fresh installations require explicit CONNECTOR_CONTENT_ENROLL_FRESH=true enrollment.
