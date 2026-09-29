# @tinychat/frontend

## 0.2.0-beta.2

### Minor Changes

- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

## 0.1.1-beta.1

No changes in this release.

## 0.1.1-beta.0

### Patch Changes

- fb522f4: Exo Local transcripts read naturally: consecutive same-speaker segments merge into turns (max 60 s), speakers are labelled You (mic) and Others (system audio), mic chunks that are wholly an echo of the call audio are dropped, and meeting chat can answer "what did I / what did they say".
