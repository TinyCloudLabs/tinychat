---
"@tinychat/frontend": patch
---

When an answer on a Feed card fails to send, the device keeps the kind of failure (the error code and the node's HTTP status, never the error text) in its last 20 Feed failures, so a failed send can be traced to its cause.

Details: TC-3723
