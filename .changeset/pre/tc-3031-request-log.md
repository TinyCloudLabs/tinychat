---
"@tinychat/backend": patch
---

The per-request log record now names its route only from the fixed list of routes the backend serves (anything else is `unmatched`), reports credits as a range (`0`, `1-9`, `10-99`, `100-999`, `1000+`) instead of an exact count, and uses an account pseudonym that changes every calendar month (UTC), so one account's records can be linked within a month but not across months. Details: TC-3031.
