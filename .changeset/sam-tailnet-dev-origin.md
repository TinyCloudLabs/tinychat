---
"@tinychat/backend": patch
---

Accept Sam's Tailnet dev frontend origin (https://lightning-node-1.gecko-snares.ts.net:5240) for backend testing. SIWE domain extraction now uses URL.host instead of URL.hostname to preserve non-standard ports, ensuring OpenKey-signed sessions with host:port domains are accepted.
