# exo-desktop

## 0.6.0-beta.12

No changes in this release.

## 0.6.0-beta.11

### Patch Changes

- 58fb057: Make Whisper model downloads resilient (TC-771). A dropped connection or server error now retries instead of failing the download, and a failed download resumes where it stopped instead of starting over. If Hugging Face is unavailable, the download continues from anarlog's model host, and the checksum still has to match before the model is installed. The Local recording panel now gives up only when a download stops making progress, so slow connections can finish Whisper Large Turbo.

## 0.6.0-beta.10

### Patch Changes

- 5e6a289: Keep on-device recordings whose transcript was never saved, whether Exo quit or crashed or the Local recording view closed mid-recording. Local recording offers the recording again with Transcribe or Discard, and Transcribe saves it as a normal Exo Local meeting. A kept recording belongs to the account that recorded it, and one whose audio file is gone can only be discarded (TC-770).

## 0.6.0-beta.9

No changes in this release.

## 0.6.0-beta.8

No changes in this release.

## 0.6.0-beta.7

No changes in this release.

## 0.6.0-beta.6

No changes in this release.

## 0.6.0-beta.5

### Patch Changes

- 56ff56b: Download Whisper models from Hugging Face. The old model host started refusing the Whisper Large Turbo download (403 Forbidden), so "Download model" failed for that model (TC-769).

## 0.6.0-beta.4

No changes in this release.

## 0.6.0-beta.3

No changes in this release.

## 0.6.0-beta.2

No changes in this release.

## 0.6.0-beta.1

No changes in this release.

## 0.6.0-beta.0

No changes in this release.

## 0.5.1

### Patch Changes

- 57a7198: Connectors and Settings scroll inside their own pane again. The header and sidebar stay fixed to the window, the blank band below the content is gone, and switching Transcriber tabs no longer jumps the page.

## 0.5.1-beta.1

### Patch Changes

- 57a7198: Connectors and Settings scroll inside their own pane again. The header and sidebar stay fixed to the window, the blank band below the content is gone, and switching Transcriber tabs no longer jumps the page.

## 0.5.1-beta.0

No changes in this release.

## 0.5.0

### Patch Changes

- 304587d: Exo: turn on the Private cloud transcription engine. The desktop now compiles in the production ptx-batch upload origin, so Local recording offers Private cloud (the default until an on-device model is downloaded) for accounts the backend enables.

## 0.5.0-beta.2

### Patch Changes

- 304587d: Exo: turn on the Private cloud transcription engine. The desktop now compiles in the production ptx-batch upload origin, so Local recording offers Private cloud (the default until an on-device model is downloaded) for accounts the backend enables.

## 0.5.0-beta.1

No changes in this release.

## 0.5.0-beta.0

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.1-beta.0

No changes in this release.

## 0.4.0

No changes in this release.

## 0.4.0-beta.1

No changes in this release.

## 0.4.0-beta.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.3.0-beta.6

No changes in this release.

## 0.3.0-beta.5

No changes in this release.

## 0.3.0-beta.4

No changes in this release.

## 0.3.0-beta.3

No changes in this release.

## 0.3.0-beta.2

No changes in this release.

## 0.3.0-beta.1

No changes in this release.

## 0.3.0-beta.0

No changes in this release.

## 0.2.0

### Minor Changes

- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

### Patch Changes

- 37642de: Exo desktop: enforce a production Content-Security-Policy in the webview (bundled scripts only, an explicit allowlist of the origins the app fetches, OpenKey as the only frame), replacing `csp: null`.

## 0.2.0-beta.3

No changes in this release.

## 0.2.0-beta.2

### Minor Changes

- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

## 0.1.1-beta.1

### Patch Changes

- 37642de: Exo desktop: enforce a production Content-Security-Policy in the webview (bundled scripts only, an explicit allowlist of the origins the app fetches, OpenKey as the only frame), replacing `csp: null`.

## 0.1.1-beta.0

No changes in this release.
