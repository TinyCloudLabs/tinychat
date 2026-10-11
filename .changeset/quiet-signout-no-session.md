---
"@tinychat/frontend": patch
---

Signing out on iPhone no longer warns that OpenKey sign-out "could not be verified" when the session was restored from an earlier run and OpenKey has nothing left to sign out; a sign-out that may have left OpenKey signed in still warns, in plainer words.
