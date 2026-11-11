---
"@tinychat/frontend": patch
---

Android: TinyCloud Home's package is now `xyz.tinycloud.home`, the same id as the iPhone app, ahead of its first Google Play release. To Android it is a new app: an installed debug or sideloaded `xyz.tinycloud.exo` build does not update in place. Uninstall the old build before installing the new one (both answer the same `xyz.tinycloud.exo://` sign-in link), then sign in again; recordings the old build hadn't uploaded yet stay with it. Sign-in and Google return links are unchanged. Details: TC-2846
