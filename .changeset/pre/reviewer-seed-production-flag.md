---
"@tinychat/frontend": patch
---

The reviewer seed CLI no longer defaults to the production node: pass `--host <origin>`, or `--production` for `https://tee.node.tinycloud.xyz`. Neither, or both, is a usage error.
