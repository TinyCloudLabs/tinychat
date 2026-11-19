# Local audio cache slice

The recording device resolves its local voice-note audio on Play, including after upload. A missing device copy uses a complete downloaded space copy, then reads from the space. Downloaded copies are stored in IndexedDB. Retained recording files and downloaded blobs share a last-played eviction order and a 500 MB phone/web or 2 GB Mac cap. Eviction and Clear cached audio require the native/web saved ledger and reject `uploadAudio: false` local-only notes. The Mac adapter reads local audio through its Tauri file commands.

Settings reports only cache-eligible bytes and offers Clear cached audio. Developer logging records local/space playback, cache hits/misses, downloaded bytes and evictions.

Verification: frontend typecheck and production build passed. Focused frontend tests passed, including local playback after upload, second-play cache hits, failed/aborted downloads, eviction safety, clear, and old space-only notes. CaptureCore Swift tests passed. Android unit tests and debug APK build passed after Capacitor sync and selecting the installed Java 21 toolchain. The local iOS simulator app build did not reach compilation: Xcode 27's `ibtool --version` hangs on this machine. iOS app compilation remains for the PR's Xcode 26.6 CI build.

Overlap: #351 changes the meaning of `audio.state=saved` for local-only notes; this slice checks `uploadAudio:false` before eviction. #367 touches the Capture and Settings surfaces; retain this cache control when merging its Activity UI.
