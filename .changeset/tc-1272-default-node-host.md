---
"@tinychat/backend": patch
"@tinychat/frontend": patch
"exo-desktop": patch
---

Default new web/Tauri widget TinyCloud sessions to `https://node.tinycloud.xyz`; retain stored hosts on restore and native renewal. An anonymous new-widget-session connectivity probe may select `https://tee.node.tinycloud.xyz` once. Signed requests and uploads are never automatically replayed against another host; opaque Worker request-limit failures receive a connection/request-limit error.

Accept both exact hosted origins for backend transcript delegations. Deploy this backend compatibility change before the next web release and Amos's Pages build-variable update. Tauri receives the widget behavior in its next native release. Capacitor mobile fresh issuance retains the legacy tee-host expectation without local host probing or fallback; its node-host cutover is deferred to TC-1310. Existing sessions, share links and signed origin/audience bindings are not migrated.
