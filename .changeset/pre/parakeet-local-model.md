---
"exo-desktop": patch
"@tinychat/frontend": minor
---

The Mac app can transcribe a stopped recording with Parakeet TDT 0.6B v3, on the Mac, as an option next to the Whisper models. It is never selected by default. Capture settings lists it after the Whisper models, with Get, progress and select like them. It runs inside the app on Core ML, and no Whisper server starts for it. The download is about 674 MB from Hugging Face: the model and a speaker-diarization bundle that the runtime needs. The files go to ~/Library/Caches/qwen3-speech. A stereo recording keeps Me and Them apart, but their order inside each 30-second stretch is approximate. With a Whisper model selected, nothing changes. Nothing changes on the web or on phones.
