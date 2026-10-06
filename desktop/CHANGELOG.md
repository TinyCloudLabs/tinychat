# exo-desktop

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
