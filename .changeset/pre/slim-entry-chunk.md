---
"@tinychat/frontend": patch
"exo-desktop": patch
---

TinyCloud Home starts with less JavaScript. The startup script drops from 10.1 MB to 7.4 MB. The TinyCloud SDK's WebAssembly is now a separate file in the app bundle, fetched while the page loads, instead of 1.9 MB of base64 decoded at startup. Chat, Recording, Connectors, Apps, Settings and How it works load from their own files once Feed is up. The web app precaches everything an offline launch needs, and the desktop and phone apps load it all from the app bundle. An installed web app opened offline loads again: since the desktop quit guard (October), the startup script imported a desktop-only file the offline cache leaves out, so the page stayed blank. One copy of `@tinycloud/replica` (0.4.4, the SDK's) is installed instead of two. CI fails a build whose startup script goes over 7.6 MB or inlines WebAssembly again. Details: TC-2882
