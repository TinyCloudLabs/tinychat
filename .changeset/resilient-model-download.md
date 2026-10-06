---
"exo-desktop": patch
---

Make Whisper model downloads resilient (TC-771). A dropped connection or server error now retries instead of failing the download, and a failed download resumes where it stopped instead of starting over. If Hugging Face is unavailable, the download continues from anarlog's model host, and the checksum still has to match before the model is installed. The Local recording panel now gives up only when a download stops making progress, so slow connections can finish Whisper Large Turbo.
