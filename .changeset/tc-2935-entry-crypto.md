---
"@tinychat/frontend": patch
---

The startup bundle no longer carries a Node crypto library the browser never runs: about 435 KB less to download and parse on every launch. Details: TC-2935.
