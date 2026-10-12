---
"@tinychat/frontend": patch
---

Native OpenKey error logs (sign-in, boot restore, renew) now include the HTTP status and OAuth error code, e.g. `boot restore: INVALID_GRANT (HTTP 400 invalid_grant)`, so a forced sign-out can be traced. Messages and tokens are still never logged.
