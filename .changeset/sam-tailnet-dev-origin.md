---
"@tinychat/backend": patch
---

SIWE domain extraction now uses URL.host instead of URL.hostname to preserve non-standard ports in SIWE domain checks, enabling OpenKey-signed sessions with host:port domains (e.g., dev servers on non-standard ports).
