---
"@tinychat/frontend": patch
"exo-desktop": patch
"@tinychat/backend": patch
---

Add an explicit exact-email transcript share action to note detail, with read-only immutable encrypted snapshots, note-title display metadata, and no audio inclusion.

Adopt the published TinyCloud Web, Node and Core SDKs at 3.8.0-beta.21 for exact Share-key runtime consent, and remove the obsolete local NodeSDK sign-in patch now included upstream. Restored or disconnected sessions show "Sign in again to share" and cannot start sharing.

Details: TC-2192
