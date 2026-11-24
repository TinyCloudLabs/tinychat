---
"@tinychat/frontend": patch
---

A new account can save its first connector key under its own key. The first save finds no encryption network, so it asks once for the single permission that creates it (no read access, one hour at most), creates the network and saves the key again once. If the approval is declined or fails, nothing is stored and the usual save error is shown.

Details: TC-4243
