---
"@tinychat/frontend": patch
---

"Delete OpenKey account" first deletes your meeting recordings, voice notes and uploads, then opens OpenKey. If a deletion is still running or can't be confirmed, a notice says what's left, and you can try again or continue to OpenKey. The notetaker service's sign-in is still removed before OpenKey opens.

Details: TC-3136
