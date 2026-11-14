---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

The phone apps now serve their bundled web app from their own origin: `https://app.tinycloud.one` on Android and `tinycloudone://app.tinycloud.one` on iOS, in place of Capacitor's shared `https://localhost` and `capacitor://localhost`. The backend accepts the new origins and no longer accepts the old ones, so an app build from before this change can't reach the backend once it deploys. Updating the app moves it to a new WebView origin: its saved backend session and its local settings stay with the old origin, and the app restores the session from the device's secure store. Details: TC-3045.
