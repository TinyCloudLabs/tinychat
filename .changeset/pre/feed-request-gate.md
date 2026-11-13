---
"@tinychat/frontend": patch
---

Home Feed on a new device opens its live-update stream once, after the first load names the agents, instead of first for the registry alone and again for the agents (two node requests fewer per new-device open). Adds a per-PR gate on how many node requests and dependent rounds a Feed open costs (warm, new device, first ready, and an idle minute with the node's stream reconnect).
