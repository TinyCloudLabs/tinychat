---
"@tinychat/frontend": minor
---

Share links you open or create are now kept in your TinyCloud space (`xyz.tinycloud.tinychat/threads/shared-with-me/`, inside the existing `threads/` grant), so they follow your account to other devices and to the new Home address (TC-2830). The browser keeps only a per-account copy, which is cleared at sign-out. The first account to sign in on a browser takes over that browser's old list, once. A link opened while signed out is saved only if you then sign in on that same page.
