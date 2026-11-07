---
"@tinychat/frontend": minor
---

The Home site signs in with only the permissions Feed, Chat and Apps use (`manifest.home.json`): no secrets, no decrypt grant, and no access to the connectors, canvas, details, summaries or transcripts databases. Recording and Connectors stay on Home and ask for their own permissions in place the first time they are opened, in one OpenKey approval; once a feature has been used on a device, the next sign-in asks for it too. Background work for Recording or Connectors starts only once that feature's permissions are in place. Agent access, Canvas and Local copy stay off on Home. tinycloud.chat keeps the full grant and behaves as before. Existing Home sessions sign in once more (revision `home-1`). Linear: TC-2501
