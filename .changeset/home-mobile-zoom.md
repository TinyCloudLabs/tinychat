---
"@tinychat/frontend": patch
---

On the iPhone app, tapping a field under 16px made iOS zoom the whole page — and the zoom stayed after the keyboard closed, so Capture looked enlarged with its right edge clipped. The paste-a-transcript fields, the Fireflies API key and the Meet space code now render 16px on touch (unchanged size with a mouse), matching the composer and the notetaker form.
