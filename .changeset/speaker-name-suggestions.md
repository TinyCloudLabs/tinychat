---
"@tinychat/frontend": patch
---

Voice notes can suggest who is speaking. Beside a speaker such as "Them 2" the note offers a name ("Alice Chen?") with the words of the transcript it rests on; Use makes it that speaker's name and can be undone, Dismiss removes the suggestion, and with several suggestions Use all takes them together. Nothing is renamed until you choose Use. Suggestions are made for notes transcribed by Private or Powerful, never for on-device or pasted transcripts, from the transcript and the names already in your meetings. A new setting, Suggest speaker names, turns the automatic suggestions off; a note's transcript menu then still has Suggest names.

This is behind a build flag (`VITE_SPEAKER_NAME_SUGGESTIONS`) that is off in production, so released builds do not change yet.
