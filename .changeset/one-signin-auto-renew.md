---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

Web sign-in goes through OpenKey's own sign-in window, which can offer automatic renewal. When the owner leaves renewal on, OpenKey signs a renewal lease and returns it with the sign-in, and the app has the session's node accept it. The session then renews through that lease for up to 90 days, and the backend reissues the sign-in token from the renewed session (`POST /api/auth/verify-renewal`). If the node doesn't accept the lease, the sign-in goes ahead without renewal. Inert until OpenKey turns renewal leases on and the pinned `@openkey/sdk` returns the signed lease.
