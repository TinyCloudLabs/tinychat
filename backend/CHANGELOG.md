# @tinychat/backend

## 0.3.0

### Minor Changes

- fcbdc49: The Google OAuth callback can return to the Exo mobile app. A flow the app starts carries a `native.` tag in its `state`, and for that tag only the callback redirects `{ code, state }` to the app's fixed deep link (`xyz.tinycloud.exo://oauth/google`) instead of posting it to the web origin. States with an unknown tag are refused. Web flows are unchanged, and the registered Google redirect URI stays the same. The native return is off unless `GOOGLE_OAUTH_NATIVE_RETURN=true`; while it is off, `native.` states are refused and the callback never redirects a code to the app.

### Patch Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

- f69c62a: Private cloud transcription relay: accept PTX batch's actual job and list shapes. PTX reports lifecycle timestamps instead of `updated_at` (the relay now derives `updated_at` from the latest one), reports `retention.audio: "not_received"` before the upload, and lists jobs as `{ object: "list", data }`. Before this, every status poll and list through the relay failed with `upstream_bad_response` against a real PTX. Jobs now also carry the caller's own `channel_mode` and `channel_labels`, which is how Exo desktop and Exo mobile tell their jobs apart on one account.

## 0.3.0-beta.2

### Patch Changes

- f69c62a: Private cloud transcription relay: accept PTX batch's actual job and list shapes. PTX reports lifecycle timestamps instead of `updated_at` (the relay now derives `updated_at` from the latest one), reports `retention.audio: "not_received"` before the upload, and lists jobs as `{ object: "list", data }`. Before this, every status poll and list through the relay failed with `upstream_bad_response` against a real PTX. Jobs now also carry the caller's own `channel_mode` and `channel_labels`, which is how Exo desktop and Exo mobile tell their jobs apart on one account.

## 0.3.0-beta.1

### Minor Changes

- fcbdc49: The Google OAuth callback can return to the Exo mobile app. A flow the app starts carries a `native.` tag in its `state`, and for that tag only the callback redirects `{ code, state }` to the app's fixed deep link (`xyz.tinycloud.exo://oauth/google`) instead of posting it to the web origin. States with an unknown tag are refused. Web flows are unchanged, and the registered Google redirect URI stays the same. The native return is off unless `GOOGLE_OAUTH_NATIVE_RETURN=true`; while it is off, `native.` states are refused and the callback never redirects a code to the app.

## 0.2.1-beta.0

### Patch Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

## 0.2.0

### Minor Changes

- 2eecb38: Private cloud transcription API for Exo desktop (`/api/transcriber/private-cloud`), dark by default: `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED` plus an account allowlist gate the routes. The backend creates batch jobs on the private transcription service with an HMAC tenant reference instead of the wallet address, returns a relative upload path with a job-scoped capability (audio goes straight from the desktop to the service), and relays status, results, cancel and delete with stable error codes and correlation ids.

### Patch Changes

- e822748: Expose backendRevision and backendVersion in /api/server-info so deploys can prove the new build is live.
- 5c16fb5: Allow the Exo mobile app's fixed origins (`https://localhost` on Android, `capacitor://localhost` on iOS) in CORS.

## 0.2.0-beta.1

### Patch Changes

- 5c16fb5: Allow the Exo mobile app's fixed origins (`https://localhost` on Android, `capacitor://localhost` on iOS) in CORS.

## 0.2.0-beta.0

### Minor Changes

- 2eecb38: Private cloud transcription API for Exo desktop (`/api/transcriber/private-cloud`), dark by default: `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED` plus an account allowlist gate the routes. The backend creates batch jobs on the private transcription service with an HMAC tenant reference instead of the wallet address, returns a relative upload path with a job-scoped capability (audio goes straight from the desktop to the service), and relays status, results, cancel and delete with stable error codes and correlation ids.

### Patch Changes

- e822748: Expose backendRevision and backendVersion in /api/server-info so deploys can prove the new build is live.
