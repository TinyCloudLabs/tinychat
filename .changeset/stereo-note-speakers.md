---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Powerful transcripts of Mac recordings tell apart the people on the other side of a call. A call with several remote speakers shows them as Speaker 1, Speaker 2 and so on in place of one "Them"; your own side stays "Me", and a call with one other person still reads "Me" and "Them". Recordings made with Identify speakers off are unchanged.

A recording on Powerful keeps Identify speakers when Private transcription is unreachable or cannot tell speakers apart; before, that switched it off for every engine.

When a note is transcribed again by another engine, or its new transcript has a different set of speakers, a name given to a numbered speaker such as "Speaker 2" comes off, because that label may now be another person. Names for "Me" and "Them" stay, and the names taken off are kept with the note.
