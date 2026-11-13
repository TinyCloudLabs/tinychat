---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

TinyCloud Home (web, desktop and mobile) and the backend now use `https://node.tinycloud.xyz` as their TinyCloud node, in place of `https://tee.node.tinycloud.xyz`. Both names reach the same node, so nobody needs to sign in again. The TinyChat retrieval skill (now 0.1.1-onboarding.28) and the reviewer seed default to `https://node.tinycloud.xyz` too.

Details: TC-2923
