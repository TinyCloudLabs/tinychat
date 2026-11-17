---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

Web sign-in goes through OpenKey's own sign-in window, which can offer automatic renewal. When the owner leaves renewal on, the session renews through its OpenKey renewal lease for up to 90 days, and the backend reissues the sign-in token from the renewed session (`POST /api/auth/verify-renewal`). Inert until OpenKey turns renewal leases on and the pinned `@openkey/sdk` returns the renewal receipt.
