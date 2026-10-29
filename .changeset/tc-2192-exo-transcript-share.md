---
"@tinychat/frontend": patch
"exo-desktop": patch
"@tinychat/backend": patch
---

Add an explicit exact-email transcript share action to note detail, with read-only immutable encrypted snapshots, SDK-valid note-title filenames capped at 128 UTF-8 bytes with a nonempty fallback, and no audio inclusion.

Adopt the published TinyCloud Web, Node and Core SDKs at 3.8.0-beta.21 for exact Share-key runtime consent, and remove the obsolete local NodeSDK sign-in patch now included upstream. Restored or disconnected sessions show "Sign in again to share" and cannot start sharing.

Keep transcript-share dialogs open through same-owner, same-session runtime-grant refreshes. Reject stale account/content completions and surface interrupted shares without exposing the prior recipient or link. Treat an OpenKey cancellation of exact-key consent as a cancelled share.

Discard underlying SDK errors at the transcript-share boundary so diagnostic cause chains contain only the sanitized failure message.

Details: TC-2192
