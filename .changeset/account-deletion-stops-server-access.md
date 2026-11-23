---
"@tinychat/frontend": patch
---

Deleting an account stops Calendar autojoin and removes its Google sign-in from our server, removes the grants our server holds to write to the owner's space, stops meeting notifications, keeps other open tabs from writing the transcript grant again and signs this device out before OpenKey opens. A step that cannot be confirmed is shown with Try again and Continue, and the text says what may remain. The record of deleted meetings is not erased.

Details: TC-4160
