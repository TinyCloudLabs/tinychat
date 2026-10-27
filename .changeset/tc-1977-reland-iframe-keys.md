---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Details: TC-1977 Store connector credentials in app named keys again. Web sign-in runs OpenKey's authorize review inside the embedded OpenKey frame, so it needs no popup or extra approval screen, and the web reads its manifest, with the named-key declaration, from its own /.well-known/openkey-manifest.json, the file OpenKey verifies. The backend's /api/manifest carries no key declaration.
