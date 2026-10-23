---
"@tinychat/frontend": patch
---

Request decryption only from explicit user actions. Sign-in requests only the encryption network create grant. The decrypt grant is a separate step-up, limited to about one hour, requested by Sync now, Disconnect, Meeting sources sync, and the queued-meetings sync. Background reads never prompt; without a held grant they show the locked state until the next explicit action.
