---
"@tinychat/frontend": patch
---

Deleting an account stops meeting notifications and the server-side Fireflies import for the owner, then erases the record of deleted meetings for every connector source. A step that cannot be confirmed is shown with Try again and Continue, and the text says the record may remain.

Details: TC-4160
