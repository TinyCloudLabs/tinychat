---
"@tinychat/frontend": patch
---

Deleting an account stops Calendar autojoin and removes its Google sign-in from our server, removes the grants our server holds to write to the owner's space, stops meeting notifications and erases the record of deleted meetings for every connector source. A step that cannot be confirmed is shown with Try again and Continue, and the text says what may remain.

Details: TC-4160
