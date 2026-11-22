---
"@tinychat/frontend": patch
---

Send only hosts referenced by spaces or Secrets and keys when requesting a registry change from Settings, so moved-away hosts are not retained or probed.

Details: TC-3892
