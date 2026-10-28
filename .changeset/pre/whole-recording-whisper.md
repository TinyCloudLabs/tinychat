---
"@tinychat/frontend": patch
---

Local Whisper compares the audio it decoded with the saved recording's length. A transcript that covers less of the recording is shown as failed with the transcribed and recorded lengths, and Retry transcription runs it again.
