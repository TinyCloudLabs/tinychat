# @tinychat/frontend

## 0.3.0-beta.0

### Minor Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

## 0.2.0

### Minor Changes

- 5c16fb5: Voice notes for the Exo mobile app: a Voice notes card in Connectors → Sources (shown only inside the native app) records on the phone, saves to your TinyCloud space, plays back, keeps unsaved notes on the device and retries them, and shows when the system blocks the microphone. Voice notes appear in Library.
- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

### Patch Changes

- fb522f4: Exo Local transcripts read naturally: consecutive same-speaker segments merge into turns (max 60 s), speakers are labelled You (mic) and Others (system audio), mic chunks that are wholly an echo of the call audio are dropped, and meeting chat can answer "what did I / what did they say".
- 4542521: Keep the sign-in when Exo launches offline. A session restore that fails because the network or backend is unreachable now keeps the saved session and shows "You're offline. Exo will reconnect when you're back online." instead of signing out; "Try again" (and coming back online) re-runs the restore rather than a full OpenKey sign-in. Expired or invalid sessions still sign out as before.

## 0.2.0-beta.3

### Minor Changes

- 5c16fb5: Voice notes for the Exo mobile app: a Voice notes card in Connectors → Sources (shown only inside the native app) records on the phone, saves to your TinyCloud space, plays back, keeps unsaved notes on the device and retries them, and shows when the system blocks the microphone. Voice notes appear in Library.

### Patch Changes

- 4542521: Keep the sign-in when Exo launches offline. A session restore that fails because the network or backend is unreachable now keeps the saved session and shows "You're offline. Exo will reconnect when you're back online." instead of signing out; "Try again" (and coming back online) re-runs the restore rather than a full OpenKey sign-in. Expired or invalid sessions still sign out as before.

## 0.2.0-beta.2

### Minor Changes

- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

## 0.1.1-beta.1

No changes in this release.

## 0.1.1-beta.0

### Patch Changes

- fb522f4: Exo Local transcripts read naturally: consecutive same-speaker segments merge into turns (max 60 s), speakers are labelled You (mic) and Others (system audio), mic chunks that are wholly an echo of the call audio are dropped, and meeting chat can answer "what did I / what did they say".
