---
"@tinychat/frontend": minor
"exo-desktop": minor
---

In Chrome and other Chromium browsers on a computer or Android, TinyCloud One keeps an encrypted local copy of your transcripts, so they open faster. It starts at your next sign-in. To stop it, turn off "Keep a local copy of my transcripts on this device" in Settings, or use Delete local copy. Production builds paused this copy from 13 November until web-sdk 3.12 removed a wait of about a second and a half on Home's first screen.

Details: TC-2883
