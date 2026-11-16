---
"@tinychat/frontend": patch
---

After a page reload, opening Main's chat no longer fails with "Couldn't load your earlier messages with Main." It asks for the same approval as a new session, then loads the earlier messages. The transcript writer also renews again after a reload. Details: TC-3019.
