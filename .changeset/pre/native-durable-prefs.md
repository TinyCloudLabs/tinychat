---
"@tinychat/frontend": patch
---

The phone apps keep the app-lock settings, the record of being signed in and a pending sign-out in the device's app storage as well as the WebView's, so they survive a change of the app's WebView origin. A session restored when the app opens now locks like any cold launch when the app lock is on, including when the app opened without its record of being signed in. Details: TC-3045.
