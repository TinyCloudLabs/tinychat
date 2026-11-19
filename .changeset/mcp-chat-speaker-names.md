---
"@tinychat/backend": patch
---

Chat over the hosted MCP now shows the speaker names you set on a note. A rename (for example "Them" to "Sam") is stored on the note as `speaker_names`; the reader applies it to the transcript lines it gives the model, so answers, citations and speaker filters use the shown name. Names are cleaned the same way as in the app (one line, at most 80 characters). A name that is blank, not text, or part of an oversized map is ignored and the stored label is kept. If the names cannot be read, the stored labels are shown. Details: TC-2189
