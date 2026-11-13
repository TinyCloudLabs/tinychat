---
"@tinychat/frontend": patch
"exo-desktop": patch
---

Home's feed puts less code in the startup script, so the startup script is back under its size budget. The card animations' code, a post's page and the brief reader now load from their own files once the feed has shown. Cards still show at once, and they animate as before once that code has loaded.
