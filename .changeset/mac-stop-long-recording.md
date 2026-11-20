---
"@tinychat/frontend": patch
---

Stopping a long recording on the Mac no longer loads the whole recording into the app. The saved receipt reads none of the audio: Play shows once the Mac has finished the file, and the audio is read when you press Play, one part at a time, so the app's memory stays the same however long the recording is. When the receipt closes by itself, the recording's own page shows in its place, never the screen the recording began on, even while your TinyCloud space cannot be reached.
