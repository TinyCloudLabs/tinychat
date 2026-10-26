---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Update the TinyCloud SDK packages to 3.8.0-beta.9 (replica 0.4.0-beta.3). The local copy now syncs entry names only and fetches a value when something reads it (`replication.contentFetch: "lazy"`), so signing in no longer downloads every transcript body. The sign-in key patch is regenerated for the new SDK version.
