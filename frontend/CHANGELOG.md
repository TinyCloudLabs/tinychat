# @tinychat/frontend

## 0.1.1-beta.0

### Patch Changes

- fb522f4: Exo Local transcripts read naturally: consecutive same-speaker segments merge into turns (max 60 s), speakers are labelled You (mic) and Others (system audio), mic chunks that are wholly an echo of the call audio are dropped, and meeting chat can answer "what did I / what did they say".
