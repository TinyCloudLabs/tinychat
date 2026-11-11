---
"@tinychat/frontend": minor
---

Native sign-in offers "Continue with Apple" once OpenKey lists Apple in `GET /api/auth/providers`; it opens Sign in with Apple in the existing OpenKey sheet (TC-1233). Updates `@openkey/sdk-capacitor` to the release that accepts `loginMethod: "apple"`.
