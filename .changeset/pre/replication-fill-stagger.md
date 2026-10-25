---
"@tinychat/frontend": patch
---

The local copy starts after the app's first load and brings its prefixes up two at a time, so sign-in and reload are not slowed by a burst of requests.

The first-load gate listens for the thread store's completed list read, including a warm-cache background revalidation and failed loads, before starting the fill (or after its 45-second deadline).
