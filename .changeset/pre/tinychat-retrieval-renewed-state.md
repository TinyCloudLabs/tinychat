---
"@tinychat/frontend": patch
---

The TinyChat retrieval skill's setup treats a `tc context` session in the `renewed` state (the original grant has ended but the owner's renewal is still running) like a `present` one.

Details: TC-2904
