---
"@tinychat/backend": patch
---

The backend image installs the fixed libzstd1 package from the base distribution, which clears the image scan finding CVE-2026-124851.

Details: TC-4339
