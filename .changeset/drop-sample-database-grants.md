---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Sign-in no longer asks for access to the Health Log and Recipes sample databases, which TinyCloud One never opens. The check for a missing TinyCloud account on the phone app now reads a path inside TinyChat's own threads folder instead of the space root. Older sign-ins that still carry the two databases are still accepted.

Details: TC-4244
