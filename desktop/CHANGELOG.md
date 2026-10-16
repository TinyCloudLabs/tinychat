# exo-desktop

## 0.8.1-beta.0

No changes in this release.

## 0.8.0

### Minor Changes

- 27569de: Add an explicit, confirmed action to transcribe a committed voice note again while preserving and addressing its previous transcript revision.
- 8e2a931: Handle a full TinyCloud storage across voice notes. While storage is full, audio uploads pause: the audio stays on this device and shows as waiting for space. Each upload pass tries audio at most once while storage refuses it, so a full store is not probed once per note. The storage message is the same everywhere it appears. Plan detail appears only on the Settings banner and dialog, and Upgrade shows only when the plan is positively Free and the paywall is on. "Manage storage" opens the storage page in the external browser. Settings shows the storage state, and the upload and transcriber switches show "Paused: storage full".

  A transcript that storage refuses is handled by where it was transcribed:
  - On this device, the transcript is held on the device and marked as kept until space is available. A held transcript is retried on foreground, and after a successful write to storage. A transcript that is still refused stays held. A successful write that lands while a recovery pass is already running doesn't trigger another pass; the next write or a foreground event (focus, visibility, app active) does.
  - Private, a storage-full save fails the transcript with a non-retryable `storage_full` failure. It says the transcript wasn't saved and offers Manage storage, then Transcribe again. It says the recording is safe on this device only when the local audio is confirmed ready. Nothing retries it automatically.

  Private and hosted transcript retention (keeping a refused transcript for a later save) is not part of this change.

  A transcript save on this device that times out fails with its own "took too long" message and can be retried. It is a persisted failure, not a storage hold.

- 97cd667: Sync voice-note text independently of audio uploads and publish each local transcript revision once.

### Patch Changes

- fa85621: Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. Client-built WAVs are rechecked against the greater of the precise saved duration and exact decoded payload duration, and the latest byte cap is checked against the actual payload. Legacy integer durations use a conservative +0.5 s estimate. No Private limit is hard-coded; without a complete duration and byte advertisement Private is not offered. The backend relays the optional duration fields when PTX sends them; a client-only deploy is safe. Clock-style media durations floor fractional seconds consistently for the total and current position, and a refused Private start returns its refusal to the caller.
- f9ab032: Play voice notes from device audio whenever it exists and cache complete space downloads for later playback. Settings shows cache size and clears downloaded playback copies only; original recordings are never evicted in 0.8.0.
- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.
- 4d8481e: Keep stopped Mac audio sources durable before showing the save receipt, then prepare playable audio in a recoverable background job with reader gates and a quit prompt.
- eb70350: Show current voice-note work in a shared Activity panel and note status line, with accurate destinations and retry actions.
- b341b89: Preserve short, timed transcript segments from local and hosted engines, including channel identity and honest coarse timing.

  The backend hosted transcript GET responses gain additive sentence word times and normalized channel fields. Until the backend is deployed, long Powerful sentences fall back to coarse word-boundary splits.

  A 0.7.1 same-revision write can still overwrite a richer transcript body. The next new-client commit repairs it on resync; this is repair, not prevention.

- 9abab0d: Keep Mac microphone and system audio in separate note channels, transcribe them as Me and Them, and play notes in mono.
- bfd8aae: Add a per-device audio upload setting that defaults off, keeps audio on the recording device while syncing the note and transcript, and offers an explicit upload action for individual notes. Remove the unused Mac auto-save setting.
- dfadb5b: Show separate mic and system-audio levels on Mac recordings, with the recorder ring following Me and a thin Them trace during system capture.

## 0.8.0-beta.4

### Minor Changes

- 27569de: Add an explicit, confirmed action to transcribe a committed voice note again while preserving and addressing its previous transcript revision.
- 8e2a931: Handle a full TinyCloud storage across voice notes. While storage is full, audio uploads pause: the audio stays on this device and shows as waiting for space. Each upload pass tries audio at most once while storage refuses it, so a full store is not probed once per note. The storage message is the same everywhere it appears. Plan detail appears only on the Settings banner and dialog, and Upgrade shows only when the plan is positively Free and the paywall is on. "Manage storage" opens the storage page in the external browser. Settings shows the storage state, and the upload and transcriber switches show "Paused: storage full".

  A transcript that storage refuses is handled by where it was transcribed:
  - On this device, the transcript is held on the device and marked as kept until space is available. A held transcript is retried on foreground, and after a successful write to storage. A transcript that is still refused stays held. A successful write that lands while a recovery pass is already running doesn't trigger another pass; the next write or a foreground event (focus, visibility, app active) does.
  - Private, a storage-full save fails the transcript with a non-retryable `storage_full` failure. It says the transcript wasn't saved and offers Manage storage, then Transcribe again. It says the recording is safe on this device only when the local audio is confirmed ready. Nothing retries it automatically.

  Private and hosted transcript retention (keeping a refused transcript for a later save) is not part of this change.

  A transcript save on this device that times out fails with its own "took too long" message and can be retried. It is a persisted failure, not a storage hold.

- 97cd667: Sync voice-note text independently of audio uploads and publish each local transcript revision once.

### Patch Changes

- fa85621: Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. Client-built WAVs are rechecked against the greater of the precise saved duration and exact decoded payload duration, and the latest byte cap is checked against the actual payload. Legacy integer durations use a conservative +0.5 s estimate. No Private limit is hard-coded; without a complete duration and byte advertisement Private is not offered. The backend relays the optional duration fields when PTX sends them; a client-only deploy is safe. Clock-style media durations floor fractional seconds consistently for the total and current position, and a refused Private start returns its refusal to the caller.
- f9ab032: Play voice notes from device audio whenever it exists and cache complete space downloads for later playback. Settings shows cache size and clears downloaded playback copies only; original recordings are never evicted in 0.8.0.
- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.
- 4d8481e: Keep stopped Mac audio sources durable before showing the save receipt, then prepare playable audio in a recoverable background job with reader gates and a quit prompt.
- eb70350: Show current voice-note work in a shared Activity panel and note status line, with accurate destinations and retry actions.
- b341b89: Preserve short, timed transcript segments from local and hosted engines, including channel identity and honest coarse timing.

  The backend hosted transcript GET responses gain additive sentence word times and normalized channel fields. Until the backend is deployed, long Powerful sentences fall back to coarse word-boundary splits.

  A 0.7.1 same-revision write can still overwrite a richer transcript body. The next new-client commit repairs it on resync; this is repair, not prevention.

- 9abab0d: Keep Mac microphone and system audio in separate note channels, transcribe them as Me and Them, and play notes in mono.
- bfd8aae: Add a per-device audio upload setting that defaults off, keeps audio on the recording device while syncing the note and transcript, and offers an explicit upload action for individual notes. Remove the unused Mac auto-save setting.
- dfadb5b: Show separate mic and system-audio levels on Mac recordings, with the recorder ring following Me and a thin Them trace during system capture.

## 0.7.4

No changes in this release.

## 0.7.4-beta.4

No changes in this release.

## 0.7.4-beta.3

No changes in this release.

## 0.7.4-beta.2

No changes in this release.

## 0.7.4-beta.1

No changes in this release.

## 0.7.4-beta.0

No changes in this release.

## 0.7.3

### Patch Changes

- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.

## 0.7.3-beta.4

No changes in this release.

## 0.7.3-beta.3

No changes in this release.

## 0.7.3-beta.2

No changes in this release.

## 0.7.3-beta.1

No changes in this release.

## 0.7.3-beta.0

### Patch Changes

- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.

## 0.7.2

### Patch Changes

- b1b58a1: Open Google consent in the system browser on Exo Mac, receive the authorization code through a validated one-shot loopback listener, and exchange it using a Google Desktop OAuth client. Offer a same-tab return when a web popup is blocked.

## 0.7.2-beta.6

No changes in this release.

## 0.7.2-beta.5

### Patch Changes

- b1b58a1: Open Google consent in the system browser on Exo Mac, receive the authorization code through a validated one-shot loopback listener, and exchange it using a Google Desktop OAuth client. Offer a same-tab return when a web popup is blocked.

## 0.7.2-beta.4

No changes in this release.

## 0.7.2-beta.3

No changes in this release.

## 0.7.2-beta.2

No changes in this release.

## 0.7.2-beta.1

No changes in this release.

## 0.7.2-beta.0

No changes in this release.

## 0.7.1

### Patch Changes

- 1d60115: Update the TinyCloud SDK family to 3.2.1 for the sign-in wait and repeat-login re-bootstrap fixes (TC-998, TC-999).

## 0.7.1-beta.2

No changes in this release.

## 0.7.1-beta.1

### Patch Changes

- 1d60115: Update the TinyCloud SDK family to 3.2.1 for the sign-in wait and repeat-login re-bootstrap fixes (TC-998, TC-999).

## 0.7.1-beta.0

No changes in this release.

## 0.7.0

### Patch Changes

- ddbadf9: fix(exo desktop): allow the system-audio consent commands so Mac recording can start
- 5918a34: feat(exo): agent-readable logging in dev builds (desktop log file, iOS container log and os_log, Android logcat ExoDev), with secret redaction; release builds stay quiet
- b32bc87: fix(exo): show local transcripts before upload, mark them saved only after a verified write, and show transcription and upload progress side by side on the Mac
- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.

## 0.7.0-beta.9

No changes in this release.

## 0.7.0-beta.8

### Patch Changes

- 5918a34: feat(exo): agent-readable logging in dev builds (desktop log file, iOS container log and os_log, Android logcat ExoDev), with secret redaction; release builds stay quiet

## 0.7.0-beta.7

### Patch Changes

- b32bc87: fix(exo): show local transcripts before upload, mark them saved only after a verified write, and show transcription and upload progress side by side on the Mac

## 0.7.0-beta.6

No changes in this release.

## 0.7.0-beta.5

No changes in this release.

## 0.7.0-beta.4

No changes in this release.

## 0.7.0-beta.3

### Patch Changes

- ddbadf9: fix(exo desktop): allow the system-audio consent commands so Mac recording can start

## 0.7.0-beta.2

No changes in this release.

## 0.6.1-beta.1

### Patch Changes

- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.

## 0.6.1-beta.0

No changes in this release.

## 0.6.0

### Patch Changes

- 73cc903: Show Android Private upload status errors with a retry without delaying the app's first paint, and classify missing desktop audio by its IO error kind.
- 01dab09: Show the target, version, build number and commit at the foot of the boot screen, the desktop sidebar and the bottom of Settings; a tap copies the line.
- 3ad0aae: Confine desktop capture and on-device Whisper to vault sessions and identifiers supplied by the webview. Remove main's unrestricted transcription-start permission and core menu/tray defaults, deny image file-path reads, and enforce the release IPC permission gate. Guard Whisper stage cleanup against concurrent staging and recover orphaned note copies.
- 108e63e: Default the new desktop recorder to capturing system audio and keep corrupt recorder settings from blocking app launch. Remove the classic desktop capture engine and its native private-cloud uploader; retain transcript saving for meetings and uploads.
- 108e63e: Start existing desktop beta users with system audio on in the new recorder, while preserving choices they make afterward. Remove the unused classic cloud bridge and local-stt model download permissions.
- 108e63e: Transcribe stopped desktop recorder notes locally with the selected Whisper model, and resume unfinished transcription after a WebView reload.
- f07bac3: Make unavailable recorder modes actionable, quiet the mic-denied ring, and reserve rail space for the minimized Ribbon.
- 313dae2: Keep private cloud recordings when the Local recording view closes mid-recording, or when Exo quits before the upload finishes. The next view or launch offers a recording that was never uploaded (Transcribe in private cloud, Transcribe on this Mac, or Discard) and re-sends an interrupted upload. After a relaunch, native code re-opens the audio by session id, only inside Exo's sessions folder and without following symlinks. Every upload of a recording uses the same Idempotency-Key, so it never creates a second transcription job. The pending record is now per account, so another account never sees, resumes or clears it. A pending record from an older version is adopted only by the account whose backend can read its job. A set-aside job's upload handle is released (TC-772).
- 5e6a289: Keep on-device recordings whose transcript was never saved, whether Exo quit or crashed or the Local recording view closed mid-recording. Local recording offers the recording again with Transcribe or Discard, and Transcribe saves it as a normal Exo Local meeting. A kept recording belongs to the account that recorded it, and one whose audio file is gone can only be discarded (TC-770).
- 12957c2: Show Mac recording inputs in Via and Capture settings, persist the selected microphone, and report disconnected devices while recording from the current default.
- 297ca1a: Restore Mac Private transcription uploads from the local recording and report service failures as retryable.
- d780bde: Stream private voice-note uploads from native recording files instead of sending base64 audio through the WebView.
- d6c97cd: Disclose Private transcription and Mac system audio capture before use, and require existing Private consents to be confirmed again.
- 7b17239: Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker browser import or newly observed server delivery, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.
- 58fb057: Make Whisper model downloads resilient (TC-771). A dropped connection or server error now retries instead of failing the download, and a failed download resumes where it stopped instead of starting over. If Hugging Face is unavailable, the download continues from anarlog's model host, and the checksum still has to match before the model is installed. The Local recording panel now gives up only when a download stops making progress, so slow connections can finish Whisper Large Turbo.
- 14daf66: Honor the saved Local transcription mode and enable speaker identification for Private voice notes.
- 8249402: Stop note playback whenever capture starts or its controls become unavailable, and avoid opening a Mac output stream for mic-only capture.
- a3cade0: Read retained voice-note audio locally before the space copy, use safe transcription error copy, and remove the private transcription ten-minute cap.
- ecdc66f: A note with no transcript now has a Transcribe button with a small provider chip (Local by default, Private when offered), and a failed transcript's "Try again" lets you pick the provider.
- 56ff56b: Download Whisper models from Hugging Face. The old model host started refusing the Whisper Large Turbo download (403 Forbidden), so "Download model" failed for that model (TC-769).

## 0.6.0-beta.44

No changes in this release.

## 0.6.0-beta.43

### Patch Changes

- 73cc903: Show Android Private upload status errors with a retry without delaying the app's first paint, and classify missing desktop audio by its IO error kind.
- d6c97cd: Disclose Private transcription and Mac system audio capture before use, and require existing Private consents to be confirmed again.
- 14daf66: Honor the saved Local transcription mode and enable speaker identification for Private voice notes.

## 0.6.0-beta.42

### Patch Changes

- 297ca1a: Restore Mac Private transcription uploads from the local recording and report service failures as retryable.

## 0.6.0-beta.41

### Patch Changes

- 8249402: Stop note playback whenever capture starts or its controls become unavailable, and avoid opening a Mac output stream for mic-only capture.

## 0.6.0-beta.40

No changes in this release.

## 0.6.0-beta.39

No changes in this release.

## 0.6.0-beta.38

### Patch Changes

- 12957c2: Show Mac recording inputs in Via and Capture settings, persist the selected microphone, and report disconnected devices while recording from the current default.

## 0.6.0-beta.37

### Patch Changes

- ecdc66f: A note with no transcript now has a Transcribe button with a small provider chip (Local by default, Private when offered), and a failed transcript's "Try again" lets you pick the provider.

## 0.6.0-beta.36

No changes in this release.

## 0.6.0-beta.35

### Patch Changes

- d780bde: Stream private voice-note uploads from native recording files instead of sending base64 audio through the WebView.
- a3cade0: Read retained voice-note audio locally before the space copy, use safe transcription error copy, and remove the private transcription ten-minute cap.

## 0.6.0-beta.34

No changes in this release.

## 0.6.0-beta.33

No changes in this release.

## 0.6.0-beta.32

### Patch Changes

- f07bac3: Make unavailable recorder modes actionable, quiet the mic-denied ring, and reserve rail space for the minimized Ribbon.

## 0.6.0-beta.31

### Patch Changes

- 7b17239: Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker browser import or newly observed server delivery, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.

## 0.6.0-beta.30

### Patch Changes

- 3ad0aae: Confine desktop capture and on-device Whisper to vault sessions and identifiers supplied by the webview. Remove main's unrestricted transcription-start permission and core menu/tray defaults, deny image file-path reads, and enforce the release IPC permission gate. Guard Whisper stage cleanup against concurrent staging and recover orphaned note copies.

## 0.6.0-beta.29

No changes in this release.

## 0.6.0-beta.28

No changes in this release.

## 0.6.0-beta.27

No changes in this release.

## 0.6.0-beta.26

No changes in this release.

## 0.6.0-beta.25

### Patch Changes

- 108e63e: Default the new desktop recorder to capturing system audio and keep corrupt recorder settings from blocking app launch. Remove the classic desktop capture engine and its native private-cloud uploader; retain transcript saving for meetings and uploads.
- 108e63e: Start existing desktop beta users with system audio on in the new recorder, while preserving choices they make afterward. Remove the unused classic cloud bridge and local-stt model download permissions.
- 108e63e: Transcribe stopped desktop recorder notes locally with the selected Whisper model, and resume unfinished transcription after a WebView reload.

## 0.6.0-beta.24

No changes in this release.

## 0.6.0-beta.23

No changes in this release.

## 0.6.0-beta.22

No changes in this release.

## 0.6.0-beta.21

No changes in this release.

## 0.6.0-beta.20

No changes in this release.

## 0.6.0-beta.19

No changes in this release.

## 0.6.0-beta.18

No changes in this release.

## 0.6.0-beta.17

### Patch Changes

- 01dab09: Show the target, version, build number and commit at the foot of the boot screen, the desktop sidebar and the bottom of Settings; a tap copies the line.

## 0.6.0-beta.16

No changes in this release.

## 0.6.0-beta.15

No changes in this release.

## 0.6.0-beta.14

No changes in this release.

## 0.6.0-beta.13

### Patch Changes

- 313dae2: Keep private cloud recordings when the Local recording view closes mid-recording, or when Exo quits before the upload finishes. The next view or launch offers a recording that was never uploaded (Transcribe in private cloud, Transcribe on this Mac, or Discard) and re-sends an interrupted upload. After a relaunch, native code re-opens the audio by session id, only inside Exo's sessions folder and without following symlinks. Every upload of a recording uses the same Idempotency-Key, so it never creates a second transcription job. The pending record is now per account, so another account never sees, resumes or clears it. A pending record from an older version is adopted only by the account whose backend can read its job. A set-aside job's upload handle is released (TC-772).

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
