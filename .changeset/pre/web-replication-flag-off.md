---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Move the TinyCloud SDK family to the stable 3.3.0 set (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; `@tinycloud/replica` 0.3.0; web-sdk-wasm 1.7.7; node-sdk-wasm 1.7.8). Add an optional local read-through copy of transcript text for the web app behind a build-time flag that defaults OFF: nothing changes unless the app is built with `VITE_EXO_REPLICATION=true` (the per-browser runtime opt-in exists only outside production builds), and it refuses to turn on in Tauri, Capacitor, iOS browsers, Safari and Firefox. With the flag OFF, a local copy left by an earlier build is removed at the next load. Mirrors only audio-free transcript folders, within a 100 MB budget; reads that confirm a write use the network. Sign-out erases the local copy (a failed erase is shown and blocks reads), and Settings shows a read-only status line. A built-in kill switch forces replication off for every build and browser.
