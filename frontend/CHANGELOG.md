# @tinychat/frontend

## 0.7.0-beta.4

### Patch Changes

- 3b92372: Handle Exo transcript omissions and channel speakers, honor voice-note commit and legacy-winner semantics from TC-978, and publish retrieval pack 0.1.1-onboarding.19.

## 0.7.0-beta.3

### Patch Changes

- ddbadf9: fix(exo desktop): allow the system-audio consent commands so Mac recording can start

## 0.7.0-beta.2

### Minor Changes

- 20faa03: Refresh saved transcriber transcripts when ptx publishes a newer version, keeping previous copies in an immutable archive and preserving edited meeting titles and start times (TC-989).

## 0.6.1-beta.1

### Patch Changes

- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.

## 0.6.1-beta.0

### Patch Changes

- 37ef2fa: Treat the private transcriber's literal 'Unknown' speaker as unattributed (null) and keep it out of participants (TC-981).

## 0.6.0

### Minor Changes

- acea78c: Capture shows what's in progress and your recent notes. The Library has filters and durations, and each note shows how it got into your space.
- c05aa4e: Discard a recording you didn't mean to make: "Discard" in the recorder's header asks "Discard?" in place, with Keep and Discard. A discarded recording is stopped and deleted from the phone, never saved to your space, even if the app closes before the delete finishes.
- 4dae5f8: Shorter screens: hints in tooltips and a How it works page
- c81e6bc: Exo's new look: navy Night and paper Day themes (following your system), Literata display type, motion tokens.
- f5f20ac: Record from Capture or the chat header. A focused recorder shows where your audio goes, minimises to a live island that follows you, and shows a receipt when your note lands in your space.
- ef2f000: Capture, Chat and Connectors are the three destinations: a tab bar on phones, a rail on landscape phones and tablets, a sidebar on desktop. The phone app opens on Capture. Android Back closes sheets first.
- aa2e1f9: Upload audio and send a notetaker from Capture: each opens its own sheet (a dialog on wider screens) that shows where the audio goes, with a receipt when the transcript lands. Interrupted uploads resume on launch, and wait as "Upload paused · Continue" when your own AssemblyAI key is locked. The desktop app records on this Mac from a card at the top of Capture that keeps recording while you navigate.
- d5e1894: Add the Android native capture engine, durable voice-note recovery, app shortcut and recording notification controls.
- 671f28c: Add on-device transcription for Exo voice notes: an "On this phone" transcriber choice in the recorder and Settings, a downloadable Parakeet/sherpa-onnx model with Wi-Fi-only download and sha256 verification, and native decode-and-transcribe after Stop that works signed out and offline.
- 3661337: Native OpenKey sign-in (TC-775) is now the only sign-in path on iOS and Android — the `VITE_EXO_NATIVE_OPENKEY` build flag is gone, and so is the embedded-widget fallback on those two platforms. A widget session persisted on a device from before this change is cleared once on the next launch; the user signs in again through the native flow. Web and the Tauri desktop app are unchanged and keep the embedded widget. The registered native OpenKey client id is now committed config (`frontend/.env.production`), not something a build flag gated.
- a376332: Add native iOS voice-note capture with durable segments, recovery, account-aware sidecars, and a home-screen recording shortcut.
- da282d4: Show native voice recordings in a full-page view with pause, a waveform, and immediate local playback after Stop. Keep committed audio on the phone after upload.
- 3973e7f: Add iOS recording interruption recovery, stale notification protection, and audio input routing.
- c79b024: Add Android recording interruption recovery, paused resume notifications, and microphone input selection.
- 1cabcd5: Keep existing data readable when storage is full and show clear write failures.
- c65d24f: Add feature-gated server delivery of Private Transcription transcripts into a user's connector SQL and KV space using a verified, narrow session-key delegation. Preserve the browser importer as a ten-minute fallback and keep production rollout blocked on the node SQL-scope fix (TC-825).
- b6ffb9b: Native OpenKey sign-in for the Exo app (TC-775 E1). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected.
- fb6cce4: Restore native OpenKey sessions across app and backend JWT restarts, renew delegations before expiry, and swap the live TinyCloud session while preserving voice-note pending-save recovery. Bound native backend authentication fetches with a timeout.
- 99f170a: Keep one native recorder available above sign-in, show local notes while signed out, and durably hand off capture ownership before clearing credentials. Claim signed-out notes at the next ready session and save them through the account-aware pipeline.

### Patch Changes

- 6d9a101: Keep the native renewal test's voice-note save fixture from leaking into later Bun test files.
- 177ddc9: Expose recorded elapsed time and native mic state reasons
- 15f5c94: Persist Android capture account state, remote cleanup receipts, and recovery actions.
- d0f143f: Make the Android compensation debug hook fail both the sign-out and compensation writes so the account remains transitioning.
- 73cc903: Show Android Private upload status errors with a retry without delaying the app's first paint, and classify missing desktop audio by its IO error kind.
- ed379a7: Map microphone RMS to the recorder's perceptual level once across native, desktop, and web capture.
- 108e63e: Add a flag-gated desktop Meeting sources entry and shared modal on Connectors.
- 99e4f56: Voice-note save failures now retain their cause and upload state across retries and recovery.
- b32e046: Fix Android STT benchmark VAD framing by feeding Silero one decision window at a time.
- 01dab09: Show the target, version, build number and commit at the foot of the boot screen, the desktop sidebar and the bottom of Settings; a tap copies the line.
- 108e63e: Fix the Capture settings e2e: expose one fake service on the harness page and target the Capture heading exactly.
- 8bb9f4e: Sign-in no longer shows raw errors: Android WebViews without Ed25519 now sign in (or point to the WebView update), closing OpenKey is a quiet cancel, sign-out waits for your OpenKey confirmation, and the app is called Exo on the boot screen and in OpenKey.
- 9099a86: Signing out no longer says OpenKey sign-out "could not be verified". When OpenKey can't confirm it signed out, Exo shows one calm line: "Signed out of Exo. To use a different account, also sign out at openkey.so."
- bf477cb: Add pure view models and Soft-skin foundations for the final recorder.
- 108e63e: Capture settings: the local-model picker is a standard radio group of downloaded models, with the rest as plain rows with Get, and focus follows a download from Get to progress to the new radio.
- 108e63e: Add the desktop Capture settings popover and the DesktopCaptureExtras seam it reads, behind the final recorder flag.
- b16eca5: Stop local transcript sync before it writes across account changes.
- 5dea60d: Keep Android microphone-state reasons within the native contract, carry diagnostic detail separately, and publish read failures only after entering interrupted state.
- 972778c: Skip queued transcriber completeness reads after the account pass is cancelled.
- 108e63e: The desktop Capture home's Recent row now says so when a partial-audio notice could not be dismissed: the same inline alert as the phone sheet, on that row, with the notice kept and focus left on Dismiss.
- 108e63e: Connect the Tauri recorder to the shared voice-note contract and store its audio in Rust-owned files.
- 108e63e: Default the new desktop recorder to capturing system audio and keep corrupt recorder settings from blocking app launch. Remove the classic desktop capture engine and its native private-cloud uploader; retain transcript saving for meetings and uploads.
- 108e63e: Start existing desktop beta users with system audio on in the new recorder, while preserving choices they make afterward. Remove the unused classic cloud bridge and local-stt model download permissions.
- 108e63e: Transcribe stopped desktop recorder notes locally with the selected Whisper model, and resume unfinished transcription after a WebView reload.
- 108e63e: Store recording Markdown and moments with voice notes
- 108e63e: Add the recorder engine seam: one selector installs the native, web or desktop engine at boot (web and desktop only with the final recorder on), and native-only calls are gated on the engine's capabilities.
- f07bac3: Make unavailable recorder modes actionable, quiet the mic-denied ring, and reserve rail space for the minimized Ribbon.
- 5ce67a5: On iOS, Local transcription uses Apple's built-in on-device speech instead of downloading a 640 MB model. iOS now requires 26.
- 85aa07b: Keep iOS recording account state and remote cleanup receipts durable, recover parked pauses, and expose recovery actions.
- 3eea2fc: The phone recorder fits landscape, 320 px phones and large text: the ring is sized from its stage, the controls stay reachable by scrolling, and Done and Discard stay when the microphone drops. Desktop toasts no longer cover the status and timer.
- 477b730: Recover voice-note saves after a fresh sign-in and show the recorder for cold iOS quick actions.
- 3e3571a: Fix Android recorder Back handling, Gboard moment submission, automatic-stop copy, new-recording state, status-bar colors, and Recent note opening.
- ee207ba: Hold each recorder halo atlas bitmap for one frame before closing it. The two smallest rings were seen blank intermittently on WebKit; the WebGL draw itself is correct, and the suspected cause is closing the bitmap straight after `drawImage`. This is a hardening change: the blank was not reproduced on demand, so the fix is unproven until checked on an iPhone.
- 83cd123: Route voice notes by their committed transcriber choice and expose one recorder choice API
- 003fe5b: Keep recordings on the phone when sign-out suspends an upload, and move the app to the signed-out screen after a shared 401 session clear.
- 47cc4f7: Never say Exo will finish a recording automatically when it couldn't recover or save it, and add Try again and Delete (with a confirmation) to the couldn't-recover sheet, including recordings the phone quarantined
- 94b694c: The Done receipt is honest about a Local note: the source reads "This phone" until a transcript exists, "Saved on this phone" is said once, the gap above the receipt is gone, and a note waiting on the model shows a static "Needs the on-device model" with "Get model" and "Use Private instead" (no spinner), kept open for 10 seconds while there is something to press. A saved note's transcript block is one sentence ("Transcribe on this phone — needs a 640 MB download") with a full-width button, and offers "Transcribe with Private instead" when Private is available. Switching to Private waits until the phone's own record says the on-device job has ended (a note whose Local result already exists is never cancelled or switched, and Android no longer marks a finished note "cancelled"; iOS gets that from #263), a Private choice survives a restart, including after a retryable failure before the cloud job exists, the receipt says "Transcribing" only while a private job is really running (Audio only says nothing; finished and failed Private notes say so), and a receipt with Open stays 10 seconds. On the saved-note sheet the "Get model" and "Transcribe with Private instead" buttons are visible outline buttons in the dark theme too (they use the sheet's own fill and ring, as "Add a note" does).
- 12ec582: Keep recorder harnesses rendering with a real string space ID, validate capture issue scope after mount, and reconcile status before the best-effort sidecar scan.
- 5252d10: Choosing Local, or recording on Local, now starts the on-device model download by itself and never blocks recording. The note is saved normally and is transcribed on the phone once the model is ready, including after the app is relaunched mid-download. Progress shows quietly ("Downloading on-device model · 42%"), a failure says so with "Try again", and the Wi-Fi-only rule shows "Waiting for Wi-Fi" instead of a dead end. A Local choice is never silently switched to another transcriber.
- 0b32ebe: Play a saved note that is still on the phone through the audio element's direct file URL (resolved on Play) instead of fetching it, which iOS answers with status 0.
- 12957c2: Show Mac recording inputs in Via and Capture settings, persist the selected microphone, and report disconnected devices while recording from the current default.
- 297ca1a: Restore Mac Private transcription uploads from the local recording and report service failures as retryable.
- Merges main into the Exo iOS dogfood branch: the Library refreshes after transcript saves together with the account-checked on-device transcript sync, and Notetaker meetings save through the shared core writer.
- b60d99a: Brings the Exo dogfood fixes onto main's TinyCloud SDK 3.1 and shared-recording changes; shared recordings keep their "Shared recording" label next to the save state.
- d9c24a7: Show the full-page microphone recovery screen after an Android recording shortcut is denied, with a direct link to app settings.
- d780bde: Stream private voice-note uploads from native recording files instead of sending base64 audio through the WebView.
- 3d2d3a2: On iPhone and Android, signing in starts on Exo's own screen: an email field, Continue with Google and Use a passkey. The OpenKey sheet then opens straight on that step, and Android's browser bar is dark.
- 3177a1b: Route recorder private-cloud choices into native capture
- fb7e2d9: Add the note pipeline selector, stepper and row halo glyph (not wired into any screen yet).
- 49fba98: A voice note you just recorded now shows in Recent and the Library right away, marked "Saving…" or "On this phone", and opens from its local copy before the upload finishes. List rows are easier to tell apart: the title is the first moment or a transcript snippet (or "Voice note"), and the subtitle is the time and length.
- 23eebf2: One name for each transcription mode (Audio only, Local, Private, Powerful) in Settings, Upload, the route diagrams and saved notes, with Settings offering Private only when the recorder does. A voice note names a transcript maker only when it was transcribed. How it works says notes run up to 3 hours. Capture's In progress rows match the voice card, and the Connectors tab and Capture share one Meeting sources view whose row actions sit under the text on phones.
- e36018b: Update the OpenKey Capacitor SDK and use the shared Kotlin version for Android builds.
- 9e129f1: Native OpenKey error logs (sign-in, boot restore, renew) now include the HTTP status and OAuth error code, e.g. `boot restore: INVALID_GRANT (HTTP 400 invalid_grant)`, so a forced sign-out can be traced. Messages and tokens are still never logged.
- 54d9510: Show audio upload and transcript progress as independent tracks, including transcripts saved before their audio upload finishes.
- d47d9f9: Hide Conversation Canvas while its experimental rollout is paused, without deleting saved Canvas data.
- 108e63e: A pending-note save that fails after you switch accounts no longer shows its error on the new account's pending notes.
- 336bfcb: The recorder checks Private transcription again when the account is ready and when the app returns to the foreground, and shows "Checking…" or a failed check with "Check again". Local's "Get the on-device model" now starts the download with visible progress, size and errors, and a saved note waiting on the model says so (with a way to get it, retry, or the reason it failed) instead of "No transcript."
- d682e75: Hide other accounts' pending voice notes from signed-in capture, preserve a note's save error while newer notes upload, and log automatic save starts for device diagnosis.
- 9aa2dcc: Handle the private transcription service's 429 `capacity_exhausted` (TC-907). Calendar auto-join counts each create attempt once, so its backoff no longer doubles per attempt. An occurrence the service keeps refusing for capacity now ends after its joining window with the outcome "All TinyCloud notetakers were busy when this meeting started." Before, it was polled every 15 minutes indefinitely and never cleaned up. A manual send that hits the cap now shows the service's "All N meeting notetakers are busy…" message instead of the generic "temporarily unavailable" text, and the backend relays `Retry-After` and `retry_after_seconds` on any upstream 429.
- 02ba07e: Show automatic voice-note saving and explain when recordings belong to another account. Avoid repeating the space-wide archive sweep for each note.
- 8665739: Android Back now blurs only text-entry fields, and a failed moment mark clears the recorder's focus state.
- 69c83e2: The final phone recorder reads and changes the transcriber through the recorder provider, and names the mode that is unavailable.
- 108e63e: Add a flag-gated desktop recorder note view and a saved voice-note page and sheet with edit, copy and play-from-moment.
- 688dd3d: Keep voice-note save failures actionable and keep Recent in sync with the retry state.
- cfc7daf: Pin the OpenKey SDK WebView popup fix and explain when remote OpenKey sign-out is unavailable while completing local sign-out.
- e604971: Show a quiet "Saved — part of this recording couldn't be written" line on Recent and Library rows and on the saved receipt when a recording is missing some audio, with a details sheet (how much is missing, when known) and a Dismiss button
- 65cb50f: Add the final phone recorder screen behind VITE_EXO_RECORDER_FINAL (off by default).
- d6c97cd: Disclose Private transcription and Mac system audio capture before use, and require existing Private consents to be confirmed again.
- de2d034: Add the minimized final recorder behind the flag: a Ribbon above the tab bar, floating on the rail, and a dock in the sidebar.
- f044877: Improve theme-aware recorder contrast, visible halo discs, readable notetaker errors, and Chat banner placement.
- b8f8803: Keep a saved note's pipeline from reporting a false connection error while its space read waits behind uploads, and read again once they finish.
- be61865: Notes saved after the fact (relaunch, the sign-in claim of signed-out notes, Save now) are now handed to Private transcription once, with their own choice. Off stays off and Local is never sent to the cloud.
- 108e63e: Phone recorder: note moments with ＋ while recording, and a notes sheet with a Markdown writer and a lazily loaded Markdown preview (TC-881). The preview's WASM is no longer part of the service worker's install; it is cached after its first use.
- f23b956: Restore recorder controls when Android microphone access is granted while the app is away.
- 14aca2c: A mode changed mid-recording now stays on screen until the note is saved instead of snapping back to the default at Done. A signed-in phone that never chose a mode no longer defaults to Local while the on-device model is missing: it starts in Private (or Audio only) and says the model is needed; an explicit Local choice is kept and shows the same note.
- 7b17239: Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker browser import or newly observed server delivery, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.
- c8c1e9b: Exo uses its original neutral palette again (zinc greys, light and dark, following the system theme). Recording is shown in red and warnings in amber.
- 58717da: Voice notes waiting on your phone now upload after a relaunch: a restored session keeps its space, and a saved session with no space shows a clear error instead of dropping you at sign-in.
- 108e63e: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests; add the recorder follow-ups' interaction suites.
- 108e63e: Desktop Capture home (wide layout) behind the final-recorder flag: the Capture header with Library and the ⚙︎ settings, the idle start button and Back to recording, Upload, Meeting and Connect existing meetings, the "on this Mac" card on the app, and Recent with All / Notes / Meetings filters and capture-issue rows (including a partial-audio row with Dismiss). The Capture nav dot also shows on the rail.
- 108e63e: Bind the desktop capture settings to the Tauri recorder's model, system-audio and auto-save commands, and drop the Mac recorder card from Capture when the shared recorder is on.
- 108e63e: On the Mac app, the recorder's Local choice is Whisper: available (signed in or out) once a Whisper model is selected, named in its caption, and live as models download; saved notes and Recent rows show the after-stop Whisper progress and failure with Retry.
- 108e63e: Recorder phone UI fixes from the E1 pass: rounded focus rings on the moment field and the ＋ button, the saved note sheet keeps its formatting bar in view in Edit mode, and a failed Open Settings shows a generic line instead of the raw plugin error.
- 108e63e: Unsaved voice notes keep their Save now row on the web at rail widths ("in this browser"), and native tablets say "on this device" instead of "this Mac". The microphone recovery views show stable lines instead of native error text. Library filter chips are at least 44 px wide.
- 108e63e: The new recorder is the only recorder: `VITE_EXO_RECORDER_FINAL` is gone and the previous recorder screens, the live-edge indicator and the on-page local transcriber panel are removed. After Done, a receipt-only view shows the saved note.
- 108e63e: Recorder in a browser: the tab title follows the recording, the screen stays awake, leaving the page asks first, a keep-open notice shows once, a denied microphone gets site-permission guidance with Try again, the microphone list comes from the browser, and Local transcription stays closed on the web.
- ca5ccda: Fit the final recorder and Capture home on a 320 px phone: the Ribbon's trace stays clear of Pause (whose Day edge now shows), the modes card's labels wrap beside their dots, the paused pill keeps its distance from the minimise button, and the Capture actions fit.
- 58891dd: Soft-skin phone Capture home and Recent rows, with the capture-issue row states, behind the recorder-final flag (TC-871).
- b23d76c: Align recorder announcements with the final recorder UI and restore the dock spectrum gain and halo pixel checks.
- 233219e: Show accurate voice-note progress in lists and restore Save now when an online note is idle.
- 70a7956: Keep recorder, chat, connector, settings, and Capture controls readable and inside their layouts at 200% text size.
- c99ac25: Expose native capture recovery and write failures
- 108e63e: Expose recording note sync status and retry note loads with backoff
- e7f978f: Announce when microphone access is off in the recorder
- be3e182: Internal: split App.tsx into chat and shell modules.
- 108e63e: Test infrastructure: the Meeting sources e2e waits for Radix to move focus instead of reading it the instant the sheet unmounts, and the exo-ui harness readiness cap runs on `performance.now()` so `?freeze=1` can no longer hang a never-ready screen.
- e315bed: Voice notes now track on-device transcript syncing and queue position, and a stuck transcript read no longer blocks later retries.
- 5edd171: The note audio player shows how long the recording is as soon as it opens, with a loading state and a calm error, instead of 00:00 / 00:00. The receipt, the saved note, the Library detail and the on-phone note now share one player (play or pause, elapsed over total, scrubber).
- 08f2cdf: Show each voice note's pipeline (on this phone, in your space, transcript, notes) on the saved-note sheet and the recorder receipt, with its one next action.
- 598bd04: Show a calm recovery screen with a Reload action instead of a blank screen when the app hits an unexpected error, and recover the iOS and Android web views to the screen the user was on if the system ends their process while Exo is in the background.
- 9c6a376: On-device transcription no longer freezes the app: the iOS queue answers status and cancel while a note decodes, installed models are verified in the background (reported as "checking"), and cancel, retry and model-load races leave a note in one consistent final state.
- 108e63e: Show a one-time, dismissible notice in the desktop Capture settings that system audio is now included in Mac recordings.
- b425f3f: Save voice notes to their owner’s space with deterministic row identities and durable transcript commits.
- 799d72f: Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sends no bot while the other bot is in the call, and sends its own if that bot leaves within its joining window. It sees a neutral "Already being recorded by another TinyCloud account" state instead of a failure. With `CALENDAR_AUTOJOIN_SHARING` off (the default), that state never promises a transcript. With it on, the second account gets the transcript only if both checks pass: the other account is on its own invite, and its verified Google email accepted the bot owner's own invite. If the other account is not on its own invite, the collision shows as unverified ("an account we couldn't match to your invite") and is never shared. Shared recordings show as "Shared recording" and can be removed from your list, but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can be matched or receive a share.
- 0913742: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests.
- d8881bc: Make the iOS compensation failure probe keep account state transitioning after a failed sign-out handoff.
- d37cc52: Raise the Exo iOS minimum to iOS 18 and support a separate device test bundle identifier.
- adbbaa4: Move to TinyCloud js-sdk 3.1.0 (from 2.11.0). Sessions and grants keep their 30-day lifetimes; existing web and desktop sessions are not re-signed.
- d0c51c3: Open the app's iOS Settings page from the voice recorder's microphone access screen.
- ec1eac7: Report current iOS microphone permission in voice recorder status so access can refresh after Settings.
- 85ad869: Add the Halo Ticks recorder ring and level bar visualisers for the final recorder.
- 108e63e: Hide the legacy screen-edge glow when the final recorder is enabled.
- 25eb3df: Name local recording finalization and the saved receipt by device, and name the TinyCloud space and Private transcription in audio transfer progress.
- 14daf66: Honor the saved Local transcription mode and enable speaker identification for Private voice notes.
- 8249402: Stop note playback whenever capture starts or its controls become unavailable, and avoid opening a Mac output stream for mic-only capture.
- c3ad09b: Skip unchanged connector meeting row updates and log why saved transcriber meetings are incomplete.
- c173a11: Keep native renewal stopped when terminal sign-out cannot complete its capture handoff, while preserving renewal after a failed manual sign-out.
- 77bb2dd: Keep the empty chat welcome visible above the composer, compact the agent prompt during a minimized recording, and follow iOS Dynamic Type for rem-based text.
- 6f1e7cb: Keep transcriber API reads off the shared TinyCloud space write lane and yield between saved-recording completeness checks.
- 9c7a923: Voice-note saves now time out visibly while keeping retries safe on slow connections.
- a3cade0: Read retained voice-note audio locally before the space copy, use safe transcription error copy, and remove the private transcription ten-minute cap.
- db0a16d: Keep the Settings memory actions within narrow phone viewports.
- 7e4e880: Restore the recorder's neutral halo disc, visible dark-mode edges, and grey paused ring ticks.
- ecdc66f: A note with no transcript now has a Transcribe button with a small provider chip (Local by default, Private when offered), and a failed transcript's "Try again" lets you pick the provider.
- 45e43de: Anchor recorded elapsed time to the native checkpoint receipt
- 108e63e: Turn on the browser voice-notes engine behind the recorder flag: lazy registration, boot recovery, a fetch upload transport for private-cloud transcription, and mime-derived saved file extensions.
- 108e63e: Add a browser voice-notes engine (IndexedDB store, MediaRecorder capture, level meter) implementing the full VoiceNotesPlugin contract. Not wired in yet.
- 92f97f6: Keep partial-audio notices after a recording commits
- 108e63e: Add the desktop recorder ring view (rail and desktop layouts, in the main region), its discard confirmation and toasts, the overlay mount by layout, and shell × layout capabilities.
- 382193b: The recorder's ring ticks are neutral zinc instead of blue-violet, the timer no longer jitters (and the ＋ button no longer moves) as the digits change, and Capture and the recorder use the same fonts as Chat and Connectors.

## 0.6.0-beta.44

### Patch Changes

- c3ad09b: Skip unchanged connector meeting row updates and log why saved transcriber meetings are incomplete.

## 0.6.0-beta.43

### Patch Changes

- 73cc903: Show Android Private upload status errors with a retry without delaying the app's first paint, and classify missing desktop audio by its IO error kind.
- d6c97cd: Disclose Private transcription and Mac system audio capture before use, and require existing Private consents to be confirmed again.
- 25eb3df: Name local recording finalization and the saved receipt by device, and name the TinyCloud space and Private transcription in audio transfer progress.
- 14daf66: Honor the saved Local transcription mode and enable speaker identification for Private voice notes.

## 0.6.0-beta.42

### Patch Changes

- 297ca1a: Restore Mac Private transcription uploads from the local recording and report service failures as retryable.

## 0.6.0-beta.41

### Patch Changes

- 8249402: Stop note playback whenever capture starts or its controls become unavailable, and avoid opening a Mac output stream for mic-only capture.

## 0.6.0-beta.40

### Patch Changes

- d47d9f9: Hide Conversation Canvas while its experimental rollout is paused, without deleting saved Canvas data.

## 0.6.0-beta.39

### Patch Changes

- 54d9510: Show audio upload and transcript progress as independent tracks, including transcripts saved before their audio upload finishes.

## 0.6.0-beta.38

### Patch Changes

- 12957c2: Show Mac recording inputs in Via and Capture settings, persist the selected microphone, and report disconnected devices while recording from the current default.

## 0.6.0-beta.37

### Patch Changes

- ecdc66f: A note with no transcript now has a Transcribe button with a small provider chip (Local by default, Private when offered), and a failed transcript's "Try again" lets you pick the provider.

## 0.6.0-beta.36

### Patch Changes

- 3d2d3a2: On iPhone and Android, signing in starts on Exo's own screen: an email field, Continue with Google and Use a passkey. The OpenKey sheet then opens straight on that step, and Android's browser bar is dark.

## 0.6.0-beta.35

### Patch Changes

- d780bde: Stream private voice-note uploads from native recording files instead of sending base64 audio through the WebView.
- a3cade0: Read retained voice-note audio locally before the space copy, use safe transcription error copy, and remove the private transcription ten-minute cap.

## 0.6.0-beta.34

### Patch Changes

- 5edd171: The note audio player shows how long the recording is as soon as it opens, with a loading state and a calm error, instead of 00:00 / 00:00. The receipt, the saved note, the Library detail and the on-phone note now share one player (play or pause, elapsed over total, scrubber).
- db0a16d: Keep the Settings memory actions within narrow phone viewports.

## 0.6.0-beta.33

### Patch Changes

- 9e129f1: Native OpenKey error logs (sign-in, boot restore, renew) now include the HTTP status and OAuth error code, e.g. `boot restore: INVALID_GRANT (HTTP 400 invalid_grant)`, so a forced sign-out can be traced. Messages and tokens are still never logged.

## 0.6.0-beta.32

### Minor Changes

- 3661337: Native OpenKey sign-in (TC-775) is now the only sign-in path on iOS and Android — the `VITE_EXO_NATIVE_OPENKEY` build flag is gone, and so is the embedded-widget fallback on those two platforms. A widget session persisted on a device from before this change is cleared once on the next launch; the user signs in again through the native flow. Web and the Tauri desktop app are unchanged and keep the embedded widget. The registered native OpenKey client id is now committed config (`frontend/.env.production`), not something a build flag gated.

### Patch Changes

- ed379a7: Map microphone RMS to the recorder's perceptual level once across native, desktop, and web capture.
- 99e4f56: Voice-note save failures now retain their cause and upload state across retries and recovery.
- 8bb9f4e: Sign-in no longer shows raw errors: Android WebViews without Ed25519 now sign in (or point to the WebView update), closing OpenKey is a quiet cancel, sign-out waits for your OpenKey confirmation, and the app is called Exo on the boot screen and in OpenKey.
- 9099a86: Signing out no longer says OpenKey sign-out "could not be verified". When OpenKey can't confirm it signed out, Exo shows one calm line: "Signed out of Exo. To use a different account, also sign out at openkey.so."
- b16eca5: Stop local transcript sync before it writes across account changes.
- 972778c: Skip queued transcriber completeness reads after the account pass is cancelled.
- f07bac3: Make unavailable recorder modes actionable, quiet the mic-denied ring, and reserve rail space for the minimized Ribbon.
- 5ce67a5: On iOS, Local transcription uses Apple's built-in on-device speech instead of downloading a 640 MB model. iOS now requires 26.
- 3eea2fc: The phone recorder fits landscape, 320 px phones and large text: the ring is sized from its stage, the controls stay reachable by scrolling, and Done and Discard stay when the microphone drops. Desktop toasts no longer cover the status and timer.
- 3e3571a: Fix Android recorder Back handling, Gboard moment submission, automatic-stop copy, new-recording state, status-bar colors, and Recent note opening.
- 94b694c: The Done receipt is honest about a Local note: the source reads "This phone" until a transcript exists, "Saved on this phone" is said once, the gap above the receipt is gone, and a note waiting on the model shows a static "Needs the on-device model" with "Get model" and "Use Private instead" (no spinner), kept open for 10 seconds while there is something to press. A saved note's transcript block is one sentence ("Transcribe on this phone — needs a 640 MB download") with a full-width button, and offers "Transcribe with Private instead" when Private is available. Switching to Private waits until the phone's own record says the on-device job has ended (a note whose Local result already exists is never cancelled or switched, and Android no longer marks a finished note "cancelled"; iOS gets that from #263), a Private choice survives a restart, including after a retryable failure before the cloud job exists, the receipt says "Transcribing" only while a private job is really running (Audio only says nothing; finished and failed Private notes say so), and a receipt with Open stays 10 seconds. On the saved-note sheet the "Get model" and "Transcribe with Private instead" buttons are visible outline buttons in the dark theme too (they use the sheet's own fill and ring, as "Add a note" does).
- 5252d10: Choosing Local, or recording on Local, now starts the on-device model download by itself and never blocks recording. The note is saved normally and is transcribed on the phone once the model is ready, including after the app is relaunched mid-download. Progress shows quietly ("Downloading on-device model · 42%"), a failure says so with "Try again", and the Wi-Fi-only rule shows "Waiting for Wi-Fi" instead of a dead end. A Local choice is never silently switched to another transcriber.
- 0b32ebe: Play a saved note that is still on the phone through the audio element's direct file URL (resolved on Play) instead of fetching it, which iOS answers with status 0.
- Merges main into the Exo iOS dogfood branch: the Library refreshes after transcript saves together with the account-checked on-device transcript sync, and Notetaker meetings save through the shared core writer.
- b60d99a: Brings the Exo dogfood fixes onto main's TinyCloud SDK 3.1 and shared-recording changes; shared recordings keep their "Shared recording" label next to the save state.
- fb7e2d9: Add the note pipeline selector, stepper and row halo glyph (not wired into any screen yet).
- 49fba98: A voice note you just recorded now shows in Recent and the Library right away, marked "Saving…" or "On this phone", and opens from its local copy before the upload finishes. List rows are easier to tell apart: the title is the first moment or a transcript snippet (or "Voice note"), and the subtitle is the time and length.
- 23eebf2: One name for each transcription mode (Audio only, Local, Private, Powerful) in Settings, Upload, the route diagrams and saved notes, with Settings offering Private only when the recorder does. A voice note names a transcript maker only when it was transcribed. How it works says notes run up to 3 hours. Capture's In progress rows match the voice card, and the Connectors tab and Capture share one Meeting sources view whose row actions sit under the text on phones.
- 336bfcb: The recorder checks Private transcription again when the account is ready and when the app returns to the foreground, and shows "Checking…" or a failed check with "Check again". Local's "Get the on-device model" now starts the download with visible progress, size and errors, and a saved note waiting on the model says so (with a way to get it, retry, or the reason it failed) instead of "No transcript."
- 8665739: Android Back now blurs only text-entry fields, and a failed moment mark clears the recorder's focus state.
- 688dd3d: Keep voice-note save failures actionable and keep Recent in sync with the retry state.
- f044877: Improve theme-aware recorder contrast, visible halo discs, readable notetaker errors, and Chat banner placement.
- b8f8803: Keep a saved note's pipeline from reporting a false connection error while its space read waits behind uploads, and read again once they finish.
- be61865: Notes saved after the fact (relaunch, the sign-in claim of signed-out notes, Save now) are now handed to Private transcription once, with their own choice. Off stays off and Local is never sent to the cloud.
- 14aca2c: A mode changed mid-recording now stays on screen until the note is saved instead of snapping back to the default at Done. A signed-in phone that never chose a mode no longer defaults to Local while the on-device model is missing: it starts in Private (or Audio only) and says the model is needed; an explicit Local choice is kept and shows the same note.
- 58717da: Voice notes waiting on your phone now upload after a relaunch: a restored session keeps its space, and a saved session with no space shows a clear error instead of dropping you at sign-in.
- 233219e: Show accurate voice-note progress in lists and restore Save now when an online note is idle.
- 70a7956: Keep recorder, chat, connector, settings, and Capture controls readable and inside their layouts at 200% text size.
- e315bed: Voice notes now track on-device transcript syncing and queue position, and a stuck transcript read no longer blocks later retries.
- 08f2cdf: Show each voice note's pipeline (on this phone, in your space, transcript, notes) on the saved-note sheet and the recorder receipt, with its one next action.
- 598bd04: Show a calm recovery screen with a Reload action instead of a blank screen when the app hits an unexpected error, and recover the iOS and Android web views to the screen the user was on if the system ends their process while Exo is in the background.
- 9c6a376: On-device transcription no longer freezes the app: the iOS queue answers status and cancel while a note decodes, installed models are verified in the background (reported as "checking"), and cancel, retry and model-load races leave a note in one consistent final state.
- 77bb2dd: Keep the empty chat welcome visible above the composer, compact the agent prompt during a minimized recording, and follow iOS Dynamic Type for rem-based text.
- 6f1e7cb: Keep transcriber API reads off the shared TinyCloud space write lane and yield between saved-recording completeness checks.
- 9c7a923: Voice-note saves now time out visibly while keeping retries safe on slow connections.
- 7e4e880: Restore the recorder's neutral halo disc, visible dark-mode edges, and grey paused ring ticks.
- 382193b: The recorder's ring ticks are neutral zinc instead of blue-violet, the timer no longer jitters (and the ＋ button no longer moves) as the digits change, and Capture and the recorder use the same fonts as Chat and Connectors.

## 0.6.0-beta.31

### Patch Changes

- 7b17239: Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker browser import or newly observed server delivery, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.

## 0.6.0-beta.30

No changes in this release.

## 0.6.0-beta.29

### Minor Changes

- c65d24f: Add feature-gated server delivery of Private Transcription transcripts into a user's connector SQL and KV space using a verified, narrow session-key delegation. Preserve the browser importer as a ten-minute fallback and keep production rollout blocked on the node SQL-scope fix (TC-825).

## 0.6.0-beta.28

### Patch Changes

- 9aa2dcc: Handle the private transcription service's 429 `capacity_exhausted` (TC-907). Calendar auto-join counts each create attempt once, so its backoff no longer doubles per attempt. An occurrence the service keeps refusing for capacity now ends after its joining window with the outcome "All TinyCloud notetakers were busy when this meeting started." Before, it was polled every 15 minutes indefinitely and never cleaned up. A manual send that hits the cap now shows the service's "All N meeting notetakers are busy…" message instead of the generic "temporarily unavailable" text, and the backend relays `Retry-After` and `retry_after_seconds` on any upstream 429.

## 0.6.0-beta.27

### Patch Changes

- 799d72f: Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sends no bot while the other bot is in the call, and sends its own if that bot leaves within its joining window. It sees a neutral "Already being recorded by another TinyCloud account" state instead of a failure. With `CALENDAR_AUTOJOIN_SHARING` off (the default), that state never promises a transcript. With it on, the second account gets the transcript only if both checks pass: the other account is on its own invite, and its verified Google email accepted the bot owner's own invite. If the other account is not on its own invite, the collision shows as unverified ("an account we couldn't match to your invite") and is never shared. Shared recordings show as "Shared recording" and can be removed from your list, but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can be matched or receive a share.

## 0.6.0-beta.26

### Patch Changes

- adbbaa4: Move to TinyCloud js-sdk 3.1.0 (from 2.11.0). Sessions and grants keep their 30-day lifetimes; existing web and desktop sessions are not re-signed.

## 0.6.0-beta.25

### Patch Changes

- 108e63e: Add a flag-gated desktop Meeting sources entry and shared modal on Connectors.
- 108e63e: Fix the Capture settings e2e: expose one fake service on the harness page and target the Capture heading exactly.
- 108e63e: Capture settings: the local-model picker is a standard radio group of downloaded models, with the rest as plain rows with Get, and focus follows a download from Get to progress to the new radio.
- 108e63e: Add the desktop Capture settings popover and the DesktopCaptureExtras seam it reads, behind the final recorder flag.
- 108e63e: The desktop Capture home's Recent row now says so when a partial-audio notice could not be dismissed: the same inline alert as the phone sheet, on that row, with the notice kept and focus left on Dismiss.
- 108e63e: Connect the Tauri recorder to the shared voice-note contract and store its audio in Rust-owned files.
- 108e63e: Default the new desktop recorder to capturing system audio and keep corrupt recorder settings from blocking app launch. Remove the classic desktop capture engine and its native private-cloud uploader; retain transcript saving for meetings and uploads.
- 108e63e: Start existing desktop beta users with system audio on in the new recorder, while preserving choices they make afterward. Remove the unused classic cloud bridge and local-stt model download permissions.
- 108e63e: Transcribe stopped desktop recorder notes locally with the selected Whisper model, and resume unfinished transcription after a WebView reload.
- 108e63e: Store recording Markdown and moments with voice notes
- 108e63e: Add the recorder engine seam: one selector installs the native, web or desktop engine at boot (web and desktop only with the final recorder on), and native-only calls are gated on the engine's capabilities.
- 108e63e: A pending-note save that fails after you switch accounts no longer shows its error on the new account's pending notes.
- 108e63e: Add a flag-gated desktop recorder note view and a saved voice-note page and sheet with edit, copy and play-from-moment.
- 108e63e: Phone recorder: note moments with ＋ while recording, and a notes sheet with a Markdown writer and a lazily loaded Markdown preview (TC-881). The preview's WASM is no longer part of the service worker's install; it is cached after its first use.
- 108e63e: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests; add the recorder follow-ups' interaction suites.
- 108e63e: Desktop Capture home (wide layout) behind the final-recorder flag: the Capture header with Library and the ⚙︎ settings, the idle start button and Back to recording, Upload, Meeting and Connect existing meetings, the "on this Mac" card on the app, and Recent with All / Notes / Meetings filters and capture-issue rows (including a partial-audio row with Dismiss). The Capture nav dot also shows on the rail.
- 108e63e: Bind the desktop capture settings to the Tauri recorder's model, system-audio and auto-save commands, and drop the Mac recorder card from Capture when the shared recorder is on.
- 108e63e: On the Mac app, the recorder's Local choice is Whisper: available (signed in or out) once a Whisper model is selected, named in its caption, and live as models download; saved notes and Recent rows show the after-stop Whisper progress and failure with Retry.
- 108e63e: Recorder phone UI fixes from the E1 pass: rounded focus rings on the moment field and the ＋ button, the saved note sheet keeps its formatting bar in view in Edit mode, and a failed Open Settings shows a generic line instead of the raw plugin error.
- 108e63e: Unsaved voice notes keep their Save now row on the web at rail widths ("in this browser"), and native tablets say "on this device" instead of "this Mac". The microphone recovery views show stable lines instead of native error text. Library filter chips are at least 44 px wide.
- 108e63e: The new recorder is the only recorder: `VITE_EXO_RECORDER_FINAL` is gone and the previous recorder screens, the live-edge indicator and the on-page local transcriber panel are removed. After Done, a receipt-only view shows the saved note.
- 108e63e: Recorder in a browser: the tab title follows the recording, the screen stays awake, leaving the page asks first, a keep-open notice shows once, a denied microphone gets site-permission guidance with Try again, the microphone list comes from the browser, and Local transcription stays closed on the web.
- 108e63e: Expose recording note sync status and retry note loads with backoff
- 108e63e: Test infrastructure: the Meeting sources e2e waits for Radix to move focus instead of reading it the instant the sheet unmounts, and the exo-ui harness readiness cap runs on `performance.now()` so `?freeze=1` can no longer hang a never-ready screen.
- 108e63e: Show a one-time, dismissible notice in the desktop Capture settings that system audio is now included in Mac recordings.
- 108e63e: Hide the legacy screen-edge glow when the final recorder is enabled.
- 108e63e: Turn on the browser voice-notes engine behind the recorder flag: lazy registration, boot recovery, a fetch upload transport for private-cloud transcription, and mime-derived saved file extensions.
- 108e63e: Add a browser voice-notes engine (IndexedDB store, MediaRecorder capture, level meter) implementing the full VoiceNotesPlugin contract. Not wired in yet.
- 108e63e: Add the desktop recorder ring view (rail and desktop layouts, in the main region), its discard confirmation and toasts, the overlay mount by layout, and shell × layout capabilities.

## 0.6.0-beta.24

### Patch Changes

- d682e75: Hide other accounts' pending voice notes from signed-in capture, preserve a note's save error while newer notes upload, and log automatic save starts for device diagnosis.

## 0.6.0-beta.23

### Patch Changes

- 02ba07e: Show automatic voice-note saving and explain when recordings belong to another account. Avoid repeating the space-wide archive sweep for each note.

## 0.6.0-beta.22

### Patch Changes

- f23b956: Restore recorder controls when Android microphone access is granted while the app is away.

## 0.6.0-beta.21

### Patch Changes

- 477b730: Recover voice-note saves after a fresh sign-in and show the recorder for cold iOS quick actions.

## 0.6.0-beta.20

### Patch Changes

- ec1eac7: Report current iOS microphone permission in voice recorder status so access can refresh after Settings.

## 0.6.0-beta.19

### Patch Changes

- d0c51c3: Open the app's iOS Settings page from the voice recorder's microphone access screen.

## 0.6.0-beta.18

### Patch Changes

- ee207ba: Hold each recorder halo atlas bitmap for one frame before closing it. The two smallest rings were seen blank intermittently on WebKit; the WebGL draw itself is correct, and the suspected cause is closing the bitmap straight after `drawImage`. This is a hardening change: the blank was not reproduced on demand, so the fix is unproven until checked on an iPhone.

## 0.6.0-beta.17

### Minor Changes

- d5e1894: Add the Android native capture engine, durable voice-note recovery, app shortcut and recording notification controls.
- 671f28c: Add on-device transcription for Exo voice notes: an "On this phone" transcriber choice in the recorder and Settings, a downloadable Parakeet/sherpa-onnx model with Wi-Fi-only download and sha256 verification, and native decode-and-transcribe after Stop that works signed out and offline.
- a376332: Add native iOS voice-note capture with durable segments, recovery, account-aware sidecars, and a home-screen recording shortcut.
- da282d4: Show native voice recordings in a full-page view with pause, a waveform, and immediate local playback after Stop. Keep committed audio on the phone after upload.
- 3973e7f: Add iOS recording interruption recovery, stale notification protection, and audio input routing.
- c79b024: Add Android recording interruption recovery, paused resume notifications, and microphone input selection.
- 99f170a: Keep one native recorder available above sign-in, show local notes while signed out, and durably hand off capture ownership before clearing credentials. Claim signed-out notes at the next ready session and save them through the account-aware pipeline.

### Patch Changes

- 6d9a101: Keep the native renewal test's voice-note save fixture from leaking into later Bun test files.
- 177ddc9: Expose recorded elapsed time and native mic state reasons
- 15f5c94: Persist Android capture account state, remote cleanup receipts, and recovery actions.
- d0f143f: Make the Android compensation debug hook fail both the sign-out and compensation writes so the account remains transitioning.
- b32e046: Fix Android STT benchmark VAD framing by feeding Silero one decision window at a time.
- 01dab09: Show the target, version, build number and commit at the foot of the boot screen, the desktop sidebar and the bottom of Settings; a tap copies the line.
- bf477cb: Add pure view models and Soft-skin foundations for the final recorder.
- 5dea60d: Keep Android microphone-state reasons within the native contract, carry diagnostic detail separately, and publish read failures only after entering interrupted state.
- 85aa07b: Keep iOS recording account state and remote cleanup receipts durable, recover parked pauses, and expose recovery actions.
- 83cd123: Route voice notes by their committed transcriber choice and expose one recorder choice API
- 003fe5b: Keep recordings on the phone when sign-out suspends an upload, and move the app to the signed-out screen after a shared 401 session clear.
- 47cc4f7: Never say Exo will finish a recording automatically when it couldn't recover or save it, and add Try again and Delete (with a confirmation) to the couldn't-recover sheet, including recordings the phone quarantined
- 12ec582: Keep recorder harnesses rendering with a real string space ID, validate capture issue scope after mount, and reconcile status before the best-effort sidecar scan.
- d9c24a7: Show the full-page microphone recovery screen after an Android recording shortcut is denied, with a direct link to app settings.
- 3177a1b: Route recorder private-cloud choices into native capture
- e36018b: Update the OpenKey Capacitor SDK and use the shared Kotlin version for Android builds.
- 69c83e2: The final phone recorder reads and changes the transcriber through the recorder provider, and names the mode that is unavailable.
- cfc7daf: Pin the OpenKey SDK WebView popup fix and explain when remote OpenKey sign-out is unavailable while completing local sign-out.
- e604971: Show a quiet "Saved — part of this recording couldn't be written" line on Recent and Library rows and on the saved receipt when a recording is missing some audio, with a details sheet (how much is missing, when known) and a Dismiss button
- 65cb50f: Add the final phone recorder screen behind VITE_EXO_RECORDER_FINAL (off by default).
- de2d034: Add the minimized final recorder behind the flag: a Ribbon above the tab bar, floating on the rail, and a dock in the sidebar.
- ca5ccda: Fit the final recorder and Capture home on a 320 px phone: the Ribbon's trace stays clear of Pause (whose Day edge now shows), the modes card's labels wrap beside their dots, the paused pill keeps its distance from the minimise button, and the Capture actions fit.
- 58891dd: Soft-skin phone Capture home and Recent rows, with the capture-issue row states, behind the recorder-final flag (TC-871).
- b23d76c: Align recorder announcements with the final recorder UI and restore the dock spectrum gain and halo pixel checks.
- c99ac25: Expose native capture recovery and write failures
- e7f978f: Announce when microphone access is off in the recorder
- b425f3f: Save voice notes to their owner’s space with deterministic row identities and durable transcript commits.
- 0913742: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests.
- d8881bc: Make the iOS compensation failure probe keep account state transitioning after a failed sign-out handoff.
- d37cc52: Raise the Exo iOS minimum to iOS 18 and support a separate device test bundle identifier.
- 85ad869: Add the Halo Ticks recorder ring and level bar visualisers for the final recorder.
- c173a11: Keep native renewal stopped when terminal sign-out cannot complete its capture handoff, while preserving renewal after a failed manual sign-out.
- 45e43de: Anchor recorded elapsed time to the native checkpoint receipt
- 92f97f6: Keep partial-audio notices after a recording commits

## 0.6.0-beta.16

### Patch Changes

- 6d9a101: Keep the native renewal test's voice-note save fixture from leaking into later Bun test files.

## 0.6.0-beta.15

### Minor Changes

- fb6cce4: Restore native OpenKey sessions across app and backend JWT restarts, renew delegations before expiry, and swap the live TinyCloud session while preserving voice-note pending-save recovery. Bound native backend authentication fetches with a timeout.

## 0.6.0-beta.14

### Minor Changes

- b6ffb9b: Native OpenKey sign-in for the Exo app (TC-775 E1, behind `VITE_EXO_NATIVE_OPENKEY`). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected. The flag stays off in every build until the OpenKey server side and the registered native client ship.

## 0.6.0-beta.13

No changes in this release.

## 0.6.0-beta.12

### Minor Changes

- 1cabcd5: Keep existing data readable when storage is full and show clear write failures.

## 0.6.0-beta.11

No changes in this release.

## 0.6.0-beta.10

No changes in this release.

## 0.6.0-beta.9

### Minor Changes

- acea78c: Capture shows what's in progress and your recent notes. The Library has filters and durations, and each note shows how it got into your space.

## 0.6.0-beta.8

### Minor Changes

- c05aa4e: Discard a recording you didn't mean to make: "Discard" in the recorder's header asks "Discard?" in place, with Keep and Discard. A discarded recording is stopped and deleted from the phone, never saved to your space, even if the app closes before the delete finishes.

## 0.6.0-beta.7

### Minor Changes

- f5f20ac: Record from Capture or the chat header. A focused recorder shows where your audio goes, minimises to a live island that follows you, and shows a receipt when your note lands in your space.

## 0.6.0-beta.6

### Minor Changes

- aa2e1f9: Upload audio and send a notetaker from Capture: each opens its own sheet (a dialog on wider screens) that shows where the audio goes, with a receipt when the transcript lands. Interrupted uploads resume on launch, and wait as "Upload paused · Continue" when your own AssemblyAI key is locked. The desktop app records on this Mac from a card at the top of Capture that keeps recording while you navigate.

## 0.6.0-beta.5

No changes in this release.

## 0.6.0-beta.4

### Minor Changes

- 4dae5f8: Shorter screens: hints in tooltips and a How it works page

## 0.6.0-beta.3

### Minor Changes

- ef2f000: Capture, Chat and Connectors are the three destinations: a tab bar on phones, a rail on landscape phones and tablets, a sidebar on desktop. The phone app opens on Capture. Android Back closes sheets first.

## 0.6.0-beta.2

### Patch Changes

- c8c1e9b: Exo uses its original neutral palette again (zinc greys, light and dark, following the system theme). Recording is shown in red and warnings in amber.

## 0.6.0-beta.1

### Patch Changes

- be3e182: Internal: split App.tsx into chat and shell modules.

## 0.6.0-beta.0

### Minor Changes

- c81e6bc: Exo's new look: navy Night and paper Day themes (following your system), Literata display type, motion tokens.

## 0.5.1

### Patch Changes

- 57a7198: Connectors and Settings scroll inside their own pane again. The header and sidebar stay fixed to the window, the blank band below the content is gone, and switching Transcriber tabs no longer jumps the page.
- e5ea1ca: Exo desktop no longer offers passkeys in the OpenKey sign-in modal. WebAuthn does not work in the ad-hoc-signed Tauri webview, so the desktop shell opens OpenKey with `passkeysSupported: false` (sign-in, sign-out and Connect agent), and OpenKey offers only email and Google. The Connect agent banner on desktop now says you'll sign in with OpenKey instead of promising a passkey. Web and mobile are unchanged. Requires `@openkey/sdk` 0.11.0.

## 0.5.1-beta.1

### Patch Changes

- 57a7198: Connectors and Settings scroll inside their own pane again. The header and sidebar stay fixed to the window, the blank band below the content is gone, and switching Transcriber tabs no longer jumps the page.

## 0.5.1-beta.0

### Patch Changes

- e5ea1ca: Exo desktop no longer offers passkeys in the OpenKey sign-in modal. WebAuthn does not work in the ad-hoc-signed Tauri webview, so the desktop shell opens OpenKey with `passkeysSupported: false` (sign-in, sign-out and Connect agent), and OpenKey offers only email and Google. The Connect agent banner on desktop now says you'll sign in with OpenKey instead of promising a passkey. Web and mobile are unchanged. Requires `@openkey/sdk` 0.11.0.

## 0.5.0

### Minor Changes

- d451a1a: Store the original audio of uploaded meetings in your TinyCloud space and play it back from the meeting in Library.
- 874ad74: Upload audio: transcribe an audio file on web, desktop and mobile with Private transcription (default) or AssemblyAI, under TinyCloud's AssemblyAI account by default or your own API key, with optional speaker identification; the transcript and the original file are saved to your TinyCloud space as an Uploaded audio meeting. Settings gains a Transcription card for the default engine and which AssemblyAI account to use (with the optional own key).

### Patch Changes

- 304587d: Exo: turn on the Private cloud transcription engine. The desktop now compiles in the production ptx-batch upload origin, so Local recording offers Private cloud (the default until an on-device model is downloaded) for accounts the backend enables.
- 874ad74: Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
- 874ad74: Keep hosted AssemblyAI submission outcomes visible while deleting temporary audio, retain unresolved Discard cleanup across reloads, and preserve Retry for recoverable hosted uploads without the original file.

## 0.5.0-beta.2

### Patch Changes

- 304587d: Exo: turn on the Private cloud transcription engine. The desktop now compiles in the production ptx-batch upload origin, so Local recording offers Private cloud (the default until an on-device model is downloaded) for accounts the backend enables.

## 0.5.0-beta.1

### Minor Changes

- 874ad74: Upload audio: transcribe an audio file on web, desktop and mobile with Private transcription (default) or AssemblyAI, under TinyCloud's AssemblyAI account by default or your own API key, with optional speaker identification; the transcript and the original file are saved to your TinyCloud space as an Uploaded audio meeting. Settings gains a Transcription card for the default engine and which AssemblyAI account to use (with the optional own key).

### Patch Changes

- 874ad74: Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
- 874ad74: Keep hosted AssemblyAI submission outcomes visible while deleting temporary audio, retain unresolved Discard cleanup across reloads, and preserve Retry for recoverable hosted uploads without the original file.

## 0.5.0-beta.0

### Minor Changes

- d451a1a: Store the original audio of uploaded meetings in your TinyCloud space and play it back from the meeting in Library.

## 0.4.1

### Patch Changes

- 0a273d3: Connect agent now refuses an OpenKey key that is not the one you are signed in with. An OpenKey account can hold several keys, and each key owns separate TinyCloud spaces. If you picked another key in the Connect agent prompt, the agent was granted access to that key's data instead of your signed-in account's. TinyChat now compares the connected address with the signed-in session address (ignoring checksum casing) and stops before any grant is minted or sent. It shows both shortened addresses and asks you to choose the signed-in key.

## 0.4.1-beta.0

### Patch Changes

- 0a273d3: Connect agent now refuses an OpenKey key that is not the one you are signed in with. An OpenKey account can hold several keys, and each key owns separate TinyCloud spaces. If you picked another key in the Connect agent prompt, the agent was granted access to that key's data instead of your signed-in account's. TinyChat now compares the connected address with the signed-in session address (ignoring checksum casing) and stops before any grant is minted or sent. It shows both shortened addresses and asks you to choose the signed-in key.

## 0.4.0

### Minor Changes

- 8ae3f67: Exo on the web is now an installable app (PWA).
  - **Install Exo.** Chrome, Edge and Android offer to install tinycloud.chat as "Exo", with its own window and the same icon as the mobile app. On Chromium the page shows an "Install Exo as an app." prompt (hidden once installed, and for 30 days after "Not now"). On iOS, use Share > Add to Home Screen.
  - **Opens offline.** The installed app opens without a connection: you get the app and the "You're offline…" screen (with the offline voice recorder), not the browser's error page. Only the app itself is stored on the device. Chats, API calls and sign-in always go to the network and are never cached.
  - **Updates.** When a new version is out, Exo shows "New version of Exo available." with Reload. You can ignore it, and the new version loads the next time you open Exo after closing all its tabs.
  - The desktop and mobile apps are unchanged. They never use the web app's offline cache.

### Patch Changes

- 96007c1: Lost private agent access is no longer hidden. When an agent turn runs without private access (no session, an expired or stale grant, or a failed status check), the backend still answers from public tools, but first sends a `delegation_error` frame (`delegation_required`, `delegation_expired` or the new `delegation_unverified`). It also tells the model to send the user to Settings > Agent access to reconnect, not to pick another model. This applies to both the Eliza task path and the legacy loop. The browser shows the Reconnect banner without aborting the public answer, and a failed check reads "Couldn't verify" rather than "expired". The session status read before each turn now times out after 3s; POST and DELETE stay unbounded. Agent grants are minted for 29 days so a fast browser clock cannot trip the 30-day courier ceiling, and Connect errors name the server's code. The meeting tool contract accepts the `exo-local` source.
- 1f682a0: Chat replies start streaming without waiting for the user message to be saved to TinyCloud SQL; the save runs alongside the stream and still lands before the reply, and a new chat's first message no longer reads a compaction checkpoint it cannot have. Every thread-store SQL call is now bounded (15s), so a dropped response fails as a retryable error instead of hanging that chat's saves for the rest of the session.

## 0.4.0-beta.1

### Patch Changes

- 96007c1: Lost private agent access is no longer hidden. When an agent turn runs without private access (no session, an expired or stale grant, or a failed status check), the backend still answers from public tools, but first sends a `delegation_error` frame (`delegation_required`, `delegation_expired` or the new `delegation_unverified`). It also tells the model to send the user to Settings > Agent access to reconnect, not to pick another model. This applies to both the Eliza task path and the legacy loop. The browser shows the Reconnect banner without aborting the public answer, and a failed check reads "Couldn't verify" rather than "expired". The session status read before each turn now times out after 3s; POST and DELETE stay unbounded. Agent grants are minted for 29 days so a fast browser clock cannot trip the 30-day courier ceiling, and Connect errors name the server's code. The meeting tool contract accepts the `exo-local` source.
- 1f682a0: Chat replies start streaming without waiting for the user message to be saved to TinyCloud SQL; the save runs alongside the stream and still lands before the reply, and a new chat's first message no longer reads a compaction checkpoint it cannot have. Every thread-store SQL call is now bounded (15s), so a dropped response fails as a retryable error instead of hanging that chat's saves for the rest of the session.

## 0.4.0-beta.0

### Minor Changes

- 8ae3f67: Exo on the web is now an installable app (PWA).
  - **Install Exo.** Chrome, Edge and Android offer to install tinycloud.chat as "Exo", with its own window and the same icon as the mobile app. On Chromium the page shows an "Install Exo as an app." prompt (hidden once installed, and for 30 days after "Not now"). On iOS, use Share > Add to Home Screen.
  - **Opens offline.** The installed app opens without a connection: you get the app and the "You're offline…" screen (with the offline voice recorder), not the browser's error page. Only the app itself is stored on the device. Chats, API calls and sign-in always go to the network and are never cached.
  - **Updates.** When a new version is out, Exo shows "New version of Exo available." with Reload. You can ignore it, and the new version loads the next time you open Exo after closing all its tabs.
  - The desktop and mobile apps are unchanged. They never use the web app's offline cache.

## 0.3.0

### Minor Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

- fcbdc49: Google Meet and Calendar autojoin can be connected from the Exo mobile app. Google refuses sign-in inside the app's web view, so on mobile "Continue with Google" opens the system browser (Custom Tabs on Android, Safari on iOS) and returns to Exo when you finish. The web app's popup flow is unchanged. The in-app flow ships switched off (build flag `VITE_EXO_NATIVE_GOOGLE_OAUTH`) until it can return through a verified https link; until then the app says that Google can be connected from the web.
- ecc9346: Exo mobile: record voice notes when Exo can't connect, and they are saved once it reconnects.
  - **Record from the offline screen.** If Exo launches without a connection but your session is still held ("You're offline…" or "Can't reach Exo right now. You're still signed in."), that screen now has a voice recorder. It shows the elapsed time, the level and the same microphone warnings as the Voice notes card. Stop keeps the note on the phone, and the screen counts what is waiting: "2 notes will be saved when you're back online." The recorder stays on screen through "Try again". It is not offered when you are signed out, because there is no account to save to.
  - **Saved when the session is back.** Once Exo is signed in again, notes still on the phone (recorded offline, or from a save that failed) are saved to your TinyCloud space right away, without opening Connectors. When private-cloud transcription is on, they are queued for it just like notes saved from the card. This uses the card's own retry, so a note is never uploaded twice.
  - **A recording that is still running carries over.** If Exo reconnects while you are recording, the chat screen's voice note bar shows that recording and its Stop. The recording is never restarted.

- e7a02a2: Exo mobile: record a voice note from the chat screen, and the Google connect dialog stops offering what the app can't do yet.
  - **One-tap voice note.** Inside the native app, the header has a "Voice note" button. One tap starts recording and opens a bar under the header with the elapsed time, the level meter, the same microphone-state warnings as the Voice notes card (the system blocking the mic, no sound arriving) and Stop. The chat stays usable underneath. Stop saves the note to your TinyCloud space, after which the bar offers Open Library. If the save fails, the bar says so and the note stays on the phone. The bar uses the Voice notes card's own recorder, so saved notes appear in Connectors → Sources and Library as before. The button is not shown on Connectors, where the card has its own Record and takes over a recording that is still running. The web and desktop apps are unchanged.
  - **Google connect in the app.** While a build keeps Google sign-in off inside the app, the Google Meet and Calendar autojoin dialogs show the "isn't available in the Exo app yet" explanation and a Close button instead of "Continue with Google". When a build turns it on, the consent text says you sign in "in your browser" instead of "in a popup window". The web and desktop dialogs are unchanged.

- 4e22e2e: Exo mobile voice notes are capped at 60 minutes and stored in parts, so long notes save and play back.
  - **60-minute limit.** The phone's recorder (Android and iOS) stops a note by itself at 60 minutes, the same way Stop does, and the note is saved like any other. The card shows the limit in the last five minutes ("Recording 55:00 of 60:00") and says "Stopped at the 60-minute limit." afterwards. A recording left running can no longer grow to hundreds of megabytes (6 hours was 188 MB).
  - **Stored in 1 MiB parts.** Audio is stored in the user's space as raw parts of at most 1 MiB plus a manifest written last, read from the phone one part at a time. The production node's ingress refuses request bodies over 1 MiB, so the old single base64 value failed for notes longer than about a minute and a half. A save that fails partway leaves the note on the phone, and "Save now" resumes after the parts already stored without writing anything twice.
  - **Playback and transcription read the parts.** The player loads a note part by part (with progress) into an object URL. Notes saved before this change, stored as one value, still play and transcribe.

- f69c62a: Exo mobile voice notes can be transcribed with private cloud transcription (TinyCloud Private Transcription → Tinfoil), the same path as the desktop's Exo Local engine. It is offered only when the build has a PTX upload origin, the device can upload (iOS, or Android 8.0 and later), and the backend admits the account. The user confirms "Use private cloud" once, and the choice is kept per account. New notes are transcribed after they are saved, and older ones have a Transcribe action. The card shows progress, failures with Retry, and the transcript. "Turn off" stops anything not yet sent.

  Transcribed voice notes appear in Library and in meeting chat. A voice note that is not transcribed is not a meeting, so it never wins "my latest meeting". Exo desktop's private cloud recovery no longer adopts a phone's voice-note job: it recovers only jobs it made itself.

### Patch Changes

- d9ba752: Exo mobile: the app opens on chat instead of the marketing page, stays clear of the status bar, notch and gesture bar, and reads properly on phone-width screens.
  - **Opens in the app.** Inside the native app, `/` goes straight to `/chat`, where a signed-out user gets the sign-in screen. The web and desktop apps still open on the landing page.
  - **Safe areas.** The app shell now pads the left and right safe-area insets (landscape notch, side navigation bar) as well as the top one. The agent access prompt and its "Agent tools active." toast sit above the home indicator. Desktop browsers and the desktop app report zero insets, so their layout is unchanged.
  - **Agent access prompt on phones.** Below the `sm` breakpoint the "Connect private agent access" prompt spans the screen with its button under the text. It used to be squeezed into half the width. From `sm` up it is the same centred row as before.
  - **Library titles on phones.** Below `sm`, a meeting or voice-note title gets its own line, with the source chip and date under it, so "Voice note · Sep 29, 1:40 PM" is no longer cut to "Voice note · Sep 29, 1…". From `sm` up the row is unchanged.

## 0.3.0-beta.6

### Minor Changes

- ecc9346: Exo mobile: record voice notes when Exo can't connect, and they are saved once it reconnects.
  - **Record from the offline screen.** If Exo launches without a connection but your session is still held ("You're offline…" or "Can't reach Exo right now. You're still signed in."), that screen now has a voice recorder. It shows the elapsed time, the level and the same microphone warnings as the Voice notes card. Stop keeps the note on the phone, and the screen counts what is waiting: "2 notes will be saved when you're back online." The recorder stays on screen through "Try again". It is not offered when you are signed out, because there is no account to save to.
  - **Saved when the session is back.** Once Exo is signed in again, notes still on the phone (recorded offline, or from a save that failed) are saved to your TinyCloud space right away, without opening Connectors. When private-cloud transcription is on, they are queued for it just like notes saved from the card. This uses the card's own retry, so a note is never uploaded twice.
  - **A recording that is still running carries over.** If Exo reconnects while you are recording, the chat screen's voice note bar shows that recording and its Stop. The recording is never restarted.

## 0.3.0-beta.5

### Minor Changes

- e7a02a2: Exo mobile: record a voice note from the chat screen, and the Google connect dialog stops offering what the app can't do yet.
  - **One-tap voice note.** Inside the native app, the header has a "Voice note" button. One tap starts recording and opens a bar under the header with the elapsed time, the level meter, the same microphone-state warnings as the Voice notes card (the system blocking the mic, no sound arriving) and Stop. The chat stays usable underneath. Stop saves the note to your TinyCloud space, after which the bar offers Open Library. If the save fails, the bar says so and the note stays on the phone. The bar uses the Voice notes card's own recorder, so saved notes appear in Connectors → Sources and Library as before. The button is not shown on Connectors, where the card has its own Record and takes over a recording that is still running. The web and desktop apps are unchanged.
  - **Google connect in the app.** While a build keeps Google sign-in off inside the app, the Google Meet and Calendar autojoin dialogs show the "isn't available in the Exo app yet" explanation and a Close button instead of "Continue with Google". When a build turns it on, the consent text says you sign in "in your browser" instead of "in a popup window". The web and desktop dialogs are unchanged.

## 0.3.0-beta.4

### Minor Changes

- 4e22e2e: Exo mobile voice notes are capped at 60 minutes and stored in parts, so long notes save and play back.
  - **60-minute limit.** The phone's recorder (Android and iOS) stops a note by itself at 60 minutes, the same way Stop does, and the note is saved like any other. The card shows the limit in the last five minutes ("Recording 55:00 of 60:00") and says "Stopped at the 60-minute limit." afterwards. A recording left running can no longer grow to hundreds of megabytes (6 hours was 188 MB).
  - **Stored in 1 MiB parts.** Audio is stored in the user's space as raw parts of at most 1 MiB plus a manifest written last, read from the phone one part at a time. The production node's ingress refuses request bodies over 1 MiB, so the old single base64 value failed for notes longer than about a minute and a half. A save that fails partway leaves the note on the phone, and "Save now" resumes after the parts already stored without writing anything twice.
  - **Playback and transcription read the parts.** The player loads a note part by part (with progress) into an object URL. Notes saved before this change, stored as one value, still play and transcribe.

## 0.3.0-beta.3

### Patch Changes

- d9ba752: Exo mobile: the app opens on chat instead of the marketing page, stays clear of the status bar, notch and gesture bar, and reads properly on phone-width screens.
  - **Opens in the app.** Inside the native app, `/` goes straight to `/chat`, where a signed-out user gets the sign-in screen. The web and desktop apps still open on the landing page.
  - **Safe areas.** The app shell now pads the left and right safe-area insets (landscape notch, side navigation bar) as well as the top one. The agent access prompt and its "Agent tools active." toast sit above the home indicator. Desktop browsers and the desktop app report zero insets, so their layout is unchanged.
  - **Agent access prompt on phones.** Below the `sm` breakpoint the "Connect private agent access" prompt spans the screen with its button under the text. It used to be squeezed into half the width. From `sm` up it is the same centred row as before.
  - **Library titles on phones.** Below `sm`, a meeting or voice-note title gets its own line, with the source chip and date under it, so "Voice note · Sep 29, 1:40 PM" is no longer cut to "Voice note · Sep 29, 1…". From `sm` up the row is unchanged.

## 0.3.0-beta.2

### Minor Changes

- f69c62a: Exo mobile voice notes can be transcribed with private cloud transcription (TinyCloud Private Transcription → Tinfoil), the same path as the desktop's Exo Local engine. It is offered only when the build has a PTX upload origin, the device can upload (iOS, or Android 8.0 and later), and the backend admits the account. The user confirms "Use private cloud" once, and the choice is kept per account. New notes are transcribed after they are saved, and older ones have a Transcribe action. The card shows progress, failures with Retry, and the transcript. "Turn off" stops anything not yet sent.

  Transcribed voice notes appear in Library and in meeting chat. A voice note that is not transcribed is not a meeting, so it never wins "my latest meeting". Exo desktop's private cloud recovery no longer adopts a phone's voice-note job: it recovers only jobs it made itself.

## 0.3.0-beta.1

### Minor Changes

- fcbdc49: Google Meet and Calendar autojoin can be connected from the Exo mobile app. Google refuses sign-in inside the app's web view, so on mobile "Continue with Google" opens the system browser (Custom Tabs on Android, Safari on iOS) and returns to Exo when you finish. The web app's popup flow is unchanged. The in-app flow ships switched off (build flag `VITE_EXO_NATIVE_GOOGLE_OAUTH`) until it can return through a verified https link; until then the app says that Google can be connected from the web.

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
