---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Sign-in leaves out access to the Health Log and Recipes sample databases, which TinyCloud One never opens. The check for a missing TinyCloud account reads a path inside TinyChat's own threads folder. Older sign-ins that carry the two databases are accepted.

Details: TC-4244
