---
"@tinychat/backend": patch
---

The backend accepts the development frontend origin https://lightning-node-1.gecko-snares.ts.net:5240 for testing backend changes. The sign-in domain is read from the origin's host, port included, so sessions signed for a host:port domain are accepted.

Details: TC-4272
