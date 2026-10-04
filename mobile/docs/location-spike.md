# Location for Exo: spike findings (TC-524)

What it takes for Exo to record the user's location, in the foreground and in the background, into the user's
own TinyCloud space, with the OS showing that it happens. The prototype in this PR is **off by default and absent
from release builds**. Policy and OS facts were checked on 2026-10-04 against Apple and Android developer docs,
Apple's App Review Guidelines (June 2026) and Play Console Help. Where a fact could not be verified in official
text, it says so.

## Recommendation

1. **Ship "location sessions" first, with while-in-use permission only.** The user taps Start; Exo records until
   they tap Stop, including after they leave the app.
   - Android: a `location` foreground service with a notification and a Stop action. ACCESS_FINE/COARSE only, no
     ACCESS_BACKGROUND_LOCATION.
   - iOS: When-In-Use plus `allowsBackgroundLocationUpdates`. iOS shows the blue location pill the whole time.
   - Both OSes allow this without "all the time" / Always, as long as the session starts while the app is on
     screen. It gives the transparency Exo wants for free: the OS indicator cannot be hidden, and on Android the
     notification carries a Stop button.
   - It avoids Play's background-location declaration and Apple's Always prompt.
   - It still needs Play's foreground-service (location) declaration with a video, and a feature that genuinely
     needs `UIBackgroundModes: location` for App Review 2.5.4.
2. **Treat "all day" passive location (Always / all the time) as a separate decision, not a default.** On iOS it is
   cheap in battery (significant-change and visits) but needs Always. On Android there is no equivalent without
   ACCESS_BACKGROUND_LOCATION. That brings Play's background-location declaration, a prominent disclosure dialog
   and a video review that can take weeks. Play also treats an always-on location foreground service "equivalent
   to ACCESS_BACKGROUND_LOCATION" as background location, so a long-running service is not a way around it.
3. **"Significant-change only" is a battery choice, not a review shortcut.** On iOS, significant-change and visits
   deliver in the background, and relaunch the app, only with Always. With When-In-Use they deliver only while the
   app is in use. Android has no platform significant-change service at all. So it does not avoid the Always or
   background review. It only makes Always cheaper once you have it.
4. **Plan for Play's new location declaration.** Play announced a declaration for any app using
   `ACCESS_FINE_LOCATION`. The form opens in November 2026; it is mandatory from **2027-01-27**. "Live tracking" is
   a listed use case. Apps targeting API 37 must use the system location button for one-time precise location.
   Whatever Exo ships after January needs this form, even for sessions only.
5. **Native upload is the real engineering gap.** Samples are captured natively and queued on the device. Today
   only the web layer can write to TinyCloud (the session key lives in the WebView). Background relaunches on iOS
   have no WebView, and a suspended WebView uploads nothing. A shipped version needs either a native TinyCloud
   writer (a delegated session key in the Keychain / Keystore) or acceptance that uploads happen when Exo is next
   opened.

## What is in this PR

| Piece | Where | Off by default because |
|---|---|---|
| Android plugin `Location` | `mobile/android/app/src/main/java/xyz/tinycloud/exo/location/`: `LocationPlugin` (bridge), `LocationTracker` (process-wide owner, OS-state receivers), `LocationService` (foreground service, type `location`), `LocationQueue` (on-device queue) | The permissions and the service are declared only in `app/src/debug/AndroidManifest.xml`. A release APK has neither (checked: `aapt2 dump badging`); the plugin reports `declared.foreground: false` and refuses to start. `verify-android-release.sh` fails a release that requests location. |
| iOS plugin `Location` | `mobile/ios/App/App/LocationRecorder.swift` (owner, `CLLocationManager` delegate, queue) and `LocationPlugin.swift` (bridge), registered in `ExoBridgeViewController`, resumed from `AppDelegate` | Both files are `#if DEBUG`, so Release compiles no location code and does not link CoreLocation. The Info.plist keys are added to **Debug** builds only by a Run Script phase (`App/location-spike-info-plist.sh`). `ios-build.yml` fails a Release archive with any location key, the `location` background mode, the spike's code or CoreLocation. |
| JS contract | `frontend/src/lib/location/nativeLocation.ts` | |
| Storage | `frontend/src/lib/location/locationStore.ts` | Writes only when the dev card runs. |
| Dev card | `frontend/src/chat/LocationSpikeSection.tsx`, at the top of Connectors → Sources | Lazy-loaded behind `VITE_EXO_LOCATION_SPIKE=true`. Vite inlines the flag, so a normal build contains no card code; checked in `dist/`. It also renders only when the native plugin exists. |
| CI | `ios-simulator-smoke.sh` | The Debug simulator smoke test checks that the plugin is registered and that the Debug Info.plist keys are present. It also runs a capture probe with "Always" granted and a simulated position, reported but not gating. |

### Data flow

```
OS fix ─▶ native tracker ─▶ on-device queue (JSONL, seq) ─▶ web layer: pending() ─▶ KV put ─▶ ack(seq)
OS state change ─┘                  ▲                         (when the WebView runs)
                                    └── survives WebView suspension, activity death, iOS background relaunch
```

- **Native code owns capture and the queue.**
  - The tracker is a process singleton.
  - Android: the foreground service keeps it alive.
  - iOS: `AppDelegate` recreates it when the OS relaunches the app for a significant change or a visit, which
    happens with no scene and no WebView.
  - Every fix and every OS-state change while capture is on is appended with a growing `seq`.
- **The web layer drains the queue.**
  - When: on mount, when the page becomes visible, every 30 s while capturing, after Stop, and on "Save now".
  - It writes a page of up to 200 entries as one KV value and acks through the page's last `seq`.
  - A failed write acks nothing.
  - A write that succeeded but was not acked is re-read from the same `seq` and overwrites the same key with a
    superset, so it never duplicates.
- **Android:** Capacitor does not pause the WebView in the background, and the foreground service keeps the process
  alive, so the 30 s loop should keep uploading while backgrounded. Chromium throttles timers in hidden pages, so
  expect about once a minute. This is a device check below.
- **iOS:** the WKWebView is suspended in the background, so uploads wait until Exo is opened.

## Permission flows

### Android (API 24 to 36; tested target 36)

1. **Foreground.**
   - `requestPermission({ level: "foreground" })` asks for ACCESS_COARSE + ACCESS_FINE together. Both are needed for
     Android 12+ to offer the choice.
   - Dialog (Android 12+): **"Allow Exo to access this device's location?"** with **Precise / Approximate** and
     **"While using the app" / "Only this time" / "Don't allow"**.
   - Approximate grants only COARSE: the app sees `accuracy: "approximate"`.
   - Asking again for FINE later shows an upgrade dialog. Downgrading precise to approximate in Settings restarts
     the app's process.
   - Denying twice is permanent (no more dialog). Capacitor remembers it and the app reports `permission: "denied"`.
     Only Settings can change it (`openSettings()`).
2. **Background ("all the time"), separately and only after step 1.** Asking for both together on Android 11+ is
   ignored: neither is granted.
   - Android 10: a dialog with **"Allow all the time" / "Allow only while using the app" / "Deny"**.
   - Android 11+: no dialog grants it. The user picks **"Allow all the time"** on the app's location page in
     Settings. That page has Allow all the time / Allow only while using the app / Ask every time / Don't allow,
     plus a "Use precise location" switch.
   - `getBackgroundPermissionOptionLabel()` gives the localized label, reported as `android.backgroundOptionLabel`.
   - The plugin calls `requestPermissions(ACCESS_BACKGROUND_LOCATION)`, which in practice opens that page. No
     official text says the request opens Settings (**device check**).
3. **Notifications (Android 13+).** Asked once, at the first background Start. The answer never blocks capture.
   - Denied: the service still runs and still appears in the Task Manager (Android 13+), but its notification is
     hidden from the shade.
   - The card shows `notificationsEnabled`.
4. **Exo's own strings.**
   - Notification channel **"Location"** ("Shown while Exo is recording your location").
   - Notification title **"Exo is recording your location"**, text **"Saved to your TinyCloud space. Tap Stop to end
     it."**, an elapsed-time chronometer, and a **Stop** action.

"Only this time" reads as `foreground`: the app cannot tell it from "While using the app". With a foreground
service started while the app was visible, access lasts until the service stops.

### iOS (deployment target 15.0)

1. **When In Use.**
   - `requestWhenInUseAuthorization()`. Exo's string `NSLocationWhenInUseUsageDescription`: **"Exo records your
     location while you use it, only after you turn location on, and saves it to your TinyCloud space."**
   - System prompt buttons: **"Allow Once" / "Allow While Using App" / "Don't Allow"**, with a map and a **"Precise:
     On"** toggle. On devices the title reads "Allow "Exo" to use your location?"; Apple does not document it.
   - The prompt is shown once. Afterwards only Settings can change the answer.
   - "Allow Once" reports as `authorizedWhenInUse`, the same as "While Using". When it lapses, the status goes back
     to `notDetermined`, which the app sees as `permission: "prompt"` again.
2. **Always (upgrade).**
   - `requestAlwaysAuthorization()` while When-In-Use shows the upgrade prompt **immediately**, **once per install**,
     and not if When-In-Use came from Allow Once.
   - Exo's string `NSLocationAlwaysAndWhenInUseUsageDescription`: **"Exo keeps recording your location in the
     background after you turn it on, so your timeline has no gaps. It is saved to your TinyCloud space, and you can
     turn it off at any time."**
   - Buttons: **"Keep Only While Using" / "Change to Always Allow"**. The title wording ("…also use your location
     even when you are not using the app?") is not in Apple's docs.
   - "Keep Only While Using" produces no delegate callback. The plugin resolves when the app becomes active again.
   - After that, `backgroundRequest` is `settings`.
3. **Provisional Always (not used here).**
   - Calling `requestAlwaysAuthorization()` from `notDetermined` shows the When-In-Use prompt.
   - "Allow While Using App" then reports **`authorizedAlways`** while Settings shows While Using.
   - iOS asks the user later, when it is about to deliver an Always-only event. The app cannot tell provisional from
     real Always.
   - The spike uses the explicit two-step ladder, so the reported state is honest.
4. **Info.plist.**
   - `NSLocationAlwaysUsageDescription` is only for iOS < 11, so it is not needed.
   - Setting `allowsBackgroundLocationUpdates = true` without `UIBackgroundModes: location` crashes. The recorder
     checks the bundle first.

## What the app can and cannot observe

| | Android | iOS |
|---|---|---|
| Permission level | `checkSelfPermission`: none / while-in-use / all the time. "Don't ask again" comes from Capacitor's cache. | `authorizationStatus` (+ `locationManagerDidChangeAuthorization`, also in background) |
| Precise vs approximate | FINE granted or only COARSE | `accuracyAuthorization` full / reduced |
| Location services off | `isLocationEnabled` + `MODE_CHANGED`/`PROVIDERS_CHANGED` broadcasts; per-provider enable/disable callbacks | `locationServicesEnabled()`; the status also reads as denied |
| Battery | `isPowerSaveMode`, `getLocationPowerSaveMode()` (e.g. `gps_disabled_when_screen_off`, `foreground_only`), Doze (`isDeviceIdleMode`), `isBackgroundRestricted`, `isIgnoringBatteryOptimizations` | `isLowPowerModeEnabled`, `backgroundRefreshStatus` |
| OS paused delivery | No callback. Seen as a gap between fixes, plus the state that explains it. | `locationManagerDidPauseLocationUpdates` (`pausedByOs`) |
| FGS notification visible | `areNotificationsEnabled` (13+); dismissal via the notification's delete intent | n/a (the blue pill is not app-controlled) |
| Mock / simulated fix | `Location.isMock()` | `sourceInformation.isSimulatedBySoftware` |
| **Cannot see** | "Only this time" vs "While using"; a permission revoke (the OS kills the process, which the next start records as `process_restarted`); whether the OS indicator is on screen | "Allow Once" vs "While Using"; provisional vs real Always; a "Keep Only While Using" tap; whether the pill is shown |

Every change while capture is on is queued as a `state` event with the full summary, so the stored trail explains
its own gaps: services off, permission downgraded, battery saver, paused by the OS, process restarted, foreground
service refused.

## When the OS stops delivering

| Situation | Android | iOS |
|---|---|---|
| App leaves the screen, while-in-use only, **no** background session | Fixes stop (the card's foreground-only option shows this) | Fixes stop |
| App leaves the screen, while-in-use, background session started on screen | Continues (location foreground service) | Continues; blue pill |
| Device still for a while | Continues (fused may lower the rate) | **Paused** (`pausesLocationUpdatesAutomatically`). Never resumes on its own: the recorder restarts when the app is opened, or on a significant change with Always. |
| Process killed (memory, crash, update) | Service is `START_STICKY`. A restart from the background without ACCESS_BACKGROUND_LOCATION may be refused: recorded as `fgs_start_denied` (undocumented; field reports say it fails). | Standard updates end. Significant-change and visits relaunch the app only with Always. |
| User force-quits | Swiping from recents keeps a foreground service; Task Manager "Stop" kills the app | Apple DTS (2025): significant-change, visits and regions still relaunch (Always); standard updates do not |
| Battery saver / Low Power Mode | Depends on `getLocationPowerSaveMode()`; e.g. GPS off with the screen off | Low Power Mode turns off Background App Refresh, and with it significant-change relaunches (archived Apple guide; **unverified** today) |
| Background App Refresh off | n/a | No relaunch for location events |
| Doze | Network suspended; whether a location FGS is exempt is not documented. Uploads from the WebView would fail until a maintenance window. | n/a |
| Background app without a foreground service, with "all the time" | Throttled to "a few times each hour" (Android 8+) | n/a |
| Approximate only | About 1 to 3 km fixes | "usually within 1–20 km", a few times per hour |

## Battery modes in the prototype

| Mode | Android | iOS |
|---|---|---|
| `continuous` (default) | Platform `fused` on API 31+ when present, else `gps` (precise only) + `network`. HIGH_ACCURACY (precise) or BALANCED (approximate), 10 s / 0 m by default. | Standard updates, `kCLLocationAccuracyBest`, no distance filter, `activityType .other`, auto-pause on; with Always + background, significant-change as a wake-up net |
| `low_power` | LOW_POWER quality (cell/Wi-Fi), 5 min / 100 m | Significant-change (cell/Wi-Fi, ≥500 m, at most every 5 min) + visits |

Notes for a shipped version:

- **Battery choices.**
  - On iOS, Apple's own suggestion for long background sessions is `pausesLocationUpdatesAutomatically = false`
    with `kCLLocationAccuracyThreeKilometers` in the background, or the iOS 17 `CLLocationUpdate.liveUpdates` +
    `CLBackgroundActivitySession`, which resumes by itself.
  - On Android, `setMaxUpdateDelayMillis` (≥ 2× the interval) batches fixes in hardware.
- **Newer iOS APIs.** iOS 18's `CLServiceSession` makes the authorization goal explicit and re-asks after Allow
  Once lapses.
- **No Google Play services.** The platform `fused` provider (API 31+) is backed by Play services' fused location
  on Google devices anyway. Play services' `FusedLocationProviderClient` would add activity recognition and
  geofencing, and it would break on de-Googled phones. Not worth the dependency for sessions.
- **Interval.** iOS has no interval, only a distance filter; `intervalMs` is Android-only.

## Store review

### App Store

- **Guidelines.**
  - **2.5.4**: background modes only for their purpose. The usual rejection is "declares support for location in
    the UIBackgroundModes key… but does not have any features that require persistent location". Location
    sessions are such a feature, and they must be reachable by the reviewer.
  - **5.1.1(ii)**: purpose strings must clearly and completely describe the use.
  - **5.1.1(iv)**: offer an alternative when location is declined (e.g. entering a place by hand).
  - **5.1.5**: use location only when directly relevant, explain it in the app, and get consent.
  - **2.3.1(a)**: describe the feature specifically in the review notes, with a demo account (2.1).
- **Review notes (draft, for Sam).** Needed when Always ships; usable for sessions too.

  > Exo records the user's location only after they turn it on in Connectors → Sources → Location (off by
  > default). It builds the user's own timeline of places, used to answer questions about their day and to put
  > voice notes and meetings in context. Recording continues after the user leaves the app until they tap Stop, so
  > the timeline has no gaps; iOS shows the location indicator the whole time. [Always only:] With "Always", Exo
  > also logs significant location changes and visits when it is not open, using the low-power services. Location
  > is stored in the user's own TinyCloud space. It is not shared with third parties or used for advertising. To
  > test: sign in with the demo account (email + code), open Connectors → Sources → Location, tap Start and allow
  > location.

- **Before shipping:** check the purpose strings against the final feature. The ones in this PR describe the spike.

### Google Play

- **Foreground service declaration** (App content → Foreground service permissions, target 34+), needed for
  sessions.
  - Type `location`: a description, the user impact if it is interrupted, a **video**, and a use case.
  - The listed location use cases are "User-initiated location sharing", "Navigation" and "Geofencing"; a personal
    timeline fits none exactly. Expect questions.
  - Policy: the service must be "initiated as a continuation of an in-app, user-initiated action" and stopped when
    the task is done. Sessions with Start/Stop fit that; an all-day service does not.
- **Background location declaration** (App content → Sensitive app permissions → Location permissions). Needed the
  moment a release **declares** ACCESS_BACKGROUND_LOCATION in its manifest, used or not, on any track including
  testing. That is why the spike keeps it in the debug manifest.
  - It must be core functionality, promoted in the store description.
  - **One feature** per declaration.
  - A **video** (30 s or less recommended; YouTube, or an MP4 on Drive) showing the feature, the in-app disclosure
    and the runtime prompt.
  - Test credentials.
  - Review "may require up to several weeks", and the release waits meanwhile.
- **Prominent disclosure** (only with background location). A dialog in the app, before the runtime prompt,
  during normal use.
  - It must contain the word "location", one of "background" / "when the app is closed" / "always in use" / "when
    the app is not in use", and every feature that uses it.
  - Draft: *"Exo collects location data to build your private timeline of places, even when the app is closed or
    not in use. It is saved to your TinyCloud space and not shared."*
  - The same text must appear in the store description and on the website.
- **`ACCESS_FINE_LOCATION` declaration** (new): opens November 2026, mandatory 2027-01-27. Applies even to sessions.
- **Data safety.**
  - "Precise location" (FINE, under 3 km²) and/or "Approximate location" (COARSE).
  - Collected, not shared, for App functionality.
  - Data kept only on the device is not "collected"; uploads to the user's space are.
  - Update `mobile/README.md`'s Play checklist when this ships.

## Privacy manifest impact (`mobile/ios/App/App/PrivacyInfo.xcprivacy`)

Unchanged in this PR: Release has no location code. Shipping location adds a collected data type, the same shape
as Audio Data, because samples leave the device for the user's space without end-to-end encryption:

```xml
<!-- Location: samples recorded after the user turns location on, uploaded to their TinyCloud space. -->
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypePreciseLocation</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
```

- **Coarse location.** Add `NSPrivacyCollectedDataTypeCoarseLocation` the same way if Exo stores approximate fixes
  (the user picked Approximate). Apple's definition: Precise means three or more decimal places of
  latitude/longitude.
- **No new required-reason API.** The recorder's timestamps come from `Date` and `CLLocation.timestamp`, not
  `systemUptime`.
- **App Store Connect.** "App Privacy" must add Precise (and possibly Coarse) Location: linked to the user, not
  used for tracking, App Functionality. Add a row to the README's privacy manifest table.

## Storage

### Prototype (this PR)

The manifest grants no location prefix, and this PR must not change it. So batches go under the existing
`connectors/` KV grant, the same way voice-note audio does:

```
KV  {APP_ID}/connectors/exo-location/{installId}/{YYYY-MM-DD}/{firstSeq:012}  →  {
  v: 1, kind: "exo-location-batch", spike: "TC-524", platform, installId, firstSeq, lastSeq, savedAt,
  samples: [{ seq, at, receivedAt, lat, lon, accuracyM, altitudeM, verticalAccuracyM, speedMps, bearingDeg,
              provider, mock, accuracyAuthorization, mode, appVisible, arrivalAt?, departureAt? }],
  events:  [{ seq, at, change, reason, changed?, detail?, state: { permission, accuracy, servicesEnabled, … } }]
}
```

- **Shape.** No SQL and nothing in Library. `spike: "TC-524"` marks it for migration or deletion.
- **Why this is wrong for production.** Anything delegated `connectors/` would also read the user's location: the
  backend ingest, agents, the `tc` CLI. Location is more sensitive than meeting notes, and the user should be able
  to grant and revoke it on its own.

### Proposed model

**Manifest** (a separate grant, so it shows separately at sign-in and can be revoked or delegated on its own):

```json
{
  "service": "tinycloud.sql",
  "path": "location",
  "actions": ["read", "write", "schema"],
  "description": "Store the places and location history Exo records on your phone, only after you turn location on."
},
{
  "service": "tinycloud.kv",
  "path": "location/",
  "actions": ["get", "put", "del", "list"],
  "description": "Keep the raw location batches Exo uploads from your phone."
}
```

- **Existing sessions.** A session signed in before the manifest change lacks the grant, so the feature must
  detect that and ask for re-consent (the same issue `connectors` had).
- **Agents.** Do not add `location` to the agent's delegation by default.

**SQL** (db `{APP_ID}/location`). The TinyCloud authorizer forbids CREATE INDEX, UNIQUE and REFERENCES, so ids are
deterministic and dedup is by primary key:

```sql
CREATE TABLE IF NOT EXISTS location_point (   -- downsampled trail: about 1 per minute or 50 m, for queries and chat
  id TEXT PRIMARY KEY,                       -- "{install_id}:{seq}"
  install_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,                 -- ISO 8601, the fix time
  lat REAL NOT NULL, lon REAL NOT NULL,
  accuracy_m REAL, speed_mps REAL,
  accuracy_auth TEXT,                        -- precise | approximate
  source TEXT                                -- fused | gps | standard | significant_change | …
);
CREATE TABLE IF NOT EXISTS location_visit (   -- iOS visits / derived stays: "where was I"
  id TEXT PRIMARY KEY, install_id TEXT NOT NULL,
  arrived_at TEXT, departed_at TEXT, lat REAL NOT NULL, lon REAL NOT NULL, accuracy_m REAL,
  label TEXT                                 -- user- or agent-assigned place name
);
CREATE TABLE IF NOT EXISTS location_session ( -- one per Start/Stop, with the OS-reported reason it ended
  id TEXT PRIMARY KEY, install_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, mode TEXT, background INTEGER,
  end_reason TEXT                            -- stopped | stopped_from_notification | fgs_start_denied | process_restarted | …
);
CREATE TABLE IF NOT EXISTS location_gap (     -- OS-state events that explain missing data
  id TEXT PRIMARY KEY, install_id TEXT NOT NULL,
  at TEXT NOT NULL, change TEXT NOT NULL, reason TEXT, state TEXT  -- JSON summary
);
```

- **Raw batches.** Keep the device queue's raw batches in KV under `location/batches/…` (cheap, append-only, exact).
- **Derived rows.** Write `location_point` downsampled. Continuous capture at 10 s is about 8,600 fixes a day; one
  SQL row per fix is too many writes.
- **Retention.** Add a user setting. Keep approximate fixes approximate (never "upgrade" them).
- **Native writer.** A native TinyCloud writer would let Android's service and iOS background relaunches upload
  without the WebView. The on-device queue is already the hand-off point.

## What production would change

Not in this PR, which changes no production config.

- **Android:**
  - Move the four permissions and the `<service>` from `app/src/debug/AndroidManifest.xml` to `src/main`.
  - Drop ACCESS_BACKGROUND_LOCATION for sessions-only.
  - Remove the location check from `scripts/release/verify-android-release.sh`, or invert it to require the
    declared set.
- **iOS:**
  - Move the two usage strings and `location` in `UIBackgroundModes` into `Info.plist`.
  - Delete the Run Script phase and its script.
  - Drop `#if DEBUG` from the two Swift files.
  - Update the Release checks in `ios-build.yml`.
  - Add PrivacyInfo's Precise Location entry.
- **`manifest.json`:** the `location` SQL and `location/` KV grants above, plus re-consent handling. Move storage
  off `connectors/`.
- **UI:** a real card with an in-app explanation before the first prompt, plus the Play prominent disclosure if
  background permission ships.
- **Store work:**
  - Play: the FGS declaration plus video; the `ACCESS_FINE_LOCATION` declaration from November 2026; the
    background declaration, disclosure and video only if "all the time" ships; Data safety.
  - App Store: App Privacy and review notes.

## Verification

- **Android:** `./gradlew assembleDebug` builds. The merged debug manifest has the four permissions and the
  service. An unsigned `assembleRelease` APK requests no location permission (`aapt2 dump badging`). Capture on the
  emulator is to be checked by the main session (list in the PR).
- **iOS (CI only; no device yet):**
  - The Debug simulator build compiles, and the Run Script adds the keys: `status()` reports `declared` all true.
  - With Always granted by `simctl` and a simulated position, the capture probe recorded a `tracking: started`
    event and a sample into the native queue: 37.3349, -122.009, ±5 m, `provider: standard`, `mock: true`
    (`isSimulatedBySoftware`). `stop()` reported `sessionSamples: 1`.
  - The Release archive passes the new checks: no location keys, background mode, spike code or CoreLocation.
  - Not checked anywhere yet: prompts, background delivery, pauses and relaunches on a real iPhone (TC-518 device
    test).
- **Web:** `frontend` tsc, `bun test` (new: `locationStore.test.ts`, `LocationSpikeSection.test.tsx`), eslint. A
  default `vite build` contains no card code; with `VITE_EXO_LOCATION_SPIKE=true` it emits a
  `LocationSpikeSection` chunk.
