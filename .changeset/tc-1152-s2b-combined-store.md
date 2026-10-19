---
"@tinychat/frontend": patch
---

Add the combined-meeting data layer (TC-1152 S2b): write, delete, cascade and read-time sweep for `exo-merged` meetings. Purging a connector now also removes combined meetings that list it. Nothing user-visible ships.
