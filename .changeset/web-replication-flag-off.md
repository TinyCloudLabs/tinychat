---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Update the TinyCloud SDK family to web-sdk and node-sdk 3.3.0-beta.29, sdk-core 3.3.0-beta.28 (sdk-services 3.3.0-beta.25) and add `@tinycloud/replica` 0.3.0-beta.8. Add an optional local read-through copy of transcript text for the web app behind a flag that defaults OFF: nothing changes unless `VITE_EXO_REPLICATION=true` (or the per-browser runtime flag) is set, and it refuses to turn on in the desktop app, the phone apps, iOS browsers, Safari, Firefox, and a built-in kill switch. When on, it mirrors only audio-free transcript folders into encrypted browser storage with a 100 MB budget, reads that confirm a write bypass the local copy, sign-out erases it (a failed erase is shown and blocks reads), and Settings shows a read-only status line. When the flag is turned off (or the kill switch is engaged), a copy left in this browser is removed on the next load, keys first, then stored data; a failed removal is shown in the status line and retried on the next load. No user-visible change while the flag is off.
