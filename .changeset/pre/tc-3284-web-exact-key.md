---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

The sign-in for Connectors now asks for access to each connector key's own encryption key, next to the access that already covers your whole account. Connector keys you save are still stored the same way for now; saving them under their own key is built behind a switch that stays off. If you already use Connectors, you sign in once more the next time you open them so the new access can be approved.

Details: TC-3284
