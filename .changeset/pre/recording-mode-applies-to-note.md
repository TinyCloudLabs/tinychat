---
"@tinychat/frontend": patch
---

A mode changed mid-recording now stays on screen until the note is saved instead of snapping back to the default at Done. A signed-in phone that never chose a mode no longer defaults to Local while the on-device model is missing: it starts in Private (or Audio only) and says the model is needed; an explicit Local choice is kept and shows the same note.
