---
"@tinychat/frontend": patch
---

Skip local replica sync for browser sign-in and restored browser sessions that use SIWE grants. Avoid querying missing connector-state tables during read-only settings checks on fresh spaces.
