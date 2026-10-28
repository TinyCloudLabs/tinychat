---
"@tinychat/frontend": patch
---

On touch, an editable field smaller than 16px can make iOS zoom the whole page, and the zoom can stay after focus leaves. The paste-a-transcript fields, the Fireflies API key and the Meet space code now render 16px on touch (unchanged size with a mouse), matching the composer and the notetaker form.
