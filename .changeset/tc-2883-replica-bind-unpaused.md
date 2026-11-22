---
"@tinychat/frontend": minor
"exo-desktop": minor
---

In Chrome and other Chromium browsers on a computer or Android, TinyCloud One keeps an encrypted local copy of your transcripts again, so opening them is faster. It starts at your next sign-in or page load. Settings shows the "Keep a local copy of my transcripts on this device" switch again; turn it off to stop, or use Delete local copy. Production builds stopped making this copy on 13 November because the SDK held Home's first screen back by about a second and a half; web-sdk 3.12 removed that wait. Details: TC-2883
