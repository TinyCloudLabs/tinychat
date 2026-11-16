---
"@tinychat/frontend": patch
---

Android: TinyCloud Home's package is now `xyz.tinycloud.home`, the same id as the iPhone app, ahead of its first Google Play release. To Android it is a new app: an installed debug or sideloaded `xyz.tinycloud.exo` build does not update in place. Open the old build and let its pending recordings upload, then uninstall it (uninstalling deletes its local data, and both builds answer the same `xyz.tinycloud.exo://` sign-in link), install the new one and sign in again. Sign-in and Google return links are unchanged. Details: TC-2846
