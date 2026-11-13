---
"@tinychat/frontend": patch
"exo-desktop": patch
---

Sign-in works again on Android phones with an outdated System WebView (before Chromium 130, such as the stock WebView 113 on Android 14). Those WebViews read `xyz.tinycloud.exo://openkey/callback` with an empty host, so the OpenKey SDK refused the redirect URI with "Private-use redirect URI must have a host" before sign-in started, and a stored session couldn't be restored either. `patches/` now carries a fix to `@openkey/sdk-capacitor@0.2.0-beta.0` that reads the host from the path when the WebView leaves it empty, and still rejects a hostless redirect or a callback to another host or path. The same fix is going upstream to OpenKey. When the SDK release containing it lands, remove the patch, its `patchedDependencies` entry, and the `COPY patches` line in `backend/Dockerfile`.
