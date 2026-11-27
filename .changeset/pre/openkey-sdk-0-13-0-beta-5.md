---
"@tinychat/frontend": patch
---

The web app uses the published OpenKey sdk 0.13.0-beta.5. A sign-in window that is slow to load waits, and offers "Open in a new window" after 15 seconds. Once a page has opened a popup sign-in, its embedded requests open as popups too, so a page uses one OpenKey session. Sign-in on tinycloud.one and its finish-setup card work the same way.
