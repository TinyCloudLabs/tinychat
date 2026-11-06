---
"@tinychat/frontend": minor
---

The Home site signs in with only the permissions Feed, Chat and Apps use (`manifest.home.json`): no secrets, no decrypt grant, and no access to the connectors, canvas, details, summaries or transcripts databases. Recording and Connectors are no longer in the Home navigation; their addresses on Home point to tinycloud.chat, which keeps the full grant and behaves as before. Existing Home sessions sign in once more (revision `home-1`). Linear: TC-2501
