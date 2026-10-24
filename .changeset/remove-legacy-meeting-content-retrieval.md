---
"@tinychat/backend": patch
---

Remove the flag-gated legacy meeting content retrieval controller and its `MEETING_CONTENT_RETRIEVAL_ENABLED`, `MEETING_CONTENT_TEST_ACCOUNTS` and `MEETING_CONTENT_MODELS` settings, evaluation tooling and deploy wiring. Eliza task routing and the existing tool loop are unchanged. Details: TC-1963
