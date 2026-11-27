---
"@tinychat/backend": patch
---

Keep a deleted Fireflies meeting out of the server-side import. The server holds a one-way code of the meeting id and the delete time until the user allows those meetings back or deletes the account.

Details: TC-4414
