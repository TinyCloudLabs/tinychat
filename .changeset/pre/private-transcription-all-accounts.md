---
"@tinychat/backend": minor
---

Make Private transcription available to every signed-in account by removing the rollout flag and allowlist. Keep the route mounted when PTX is unconfigured so authenticated requests receive `service_misconfigured` and unauthenticated probes receive 401.
