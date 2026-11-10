---
"@tinychat/frontend": patch
---

Fix native OpenKey sign-in on iOS and Android (TC-2720). The native request asked for the Home feed databases and hook subscriptions, which OpenKey's native ceiling refuses, so every sign-in failed. Native sign-in now asks only for what that ceiling covers, and the Feed on the phone apps says it isn't available there yet.
