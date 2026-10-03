---
"@tinychat/frontend": patch
---

Keep the sign-in when Exo launches offline. A session restore that fails because the network or backend is unreachable now keeps the saved session and shows "You're offline. Exo will reconnect when you're back online." instead of signing out; "Try again" (and coming back online) re-runs the restore rather than a full OpenKey sign-in. Expired or invalid sessions still sign out as before.
