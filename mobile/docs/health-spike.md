# Health spike: HealthKit and Health Connect (TC-525)

What it takes for Exo (Capacitor 8, app id `xyz.tinycloud.exo`) to read health data into the user's
own TinyCloud space: steps first, then sleep and heart rate, on iOS (HealthKit) and Android (Health
Connect). October 2026. Spike branch `spike/tc-525-health`, not for merge as is.

## Summary

- **Android builds; it has not run on a device yet.** The debug build has Health Connect
  availability, the permission screen, a 7-day read of steps, sleep and heart rate, sample data, and a
  save of daily summaries to the user's space. `assembleDebug`, `assembleRelease` and lint pass, but
  this spike had no emulator: the [device checks](#device-checks-android-emulator) are what proves it.
  Health Connect tells the app exactly which permissions it holds.
- **iOS works end to end in the simulator, without an Apple team.** An ad-hoc signed ("Sign to Run
  Locally") Debug build embeds the HealthKit entitlements. In CI's iOS 26.5 simulator it shows the real
  Health Access sheet, gets authorized, writes sample data, reads 7 days of steps, sleep and heart rate,
  and registers background delivery. The unsigned build gets "Missing com.apple.developer.healthkit
  entitlement". No device can run it until the Apple Developer enrollment exists. Details in
  [iOS Simulator in CI](#ios-simulator-in-ci). HealthKit never tells an app
  whether it may read a type: a refusal looks exactly like no data. The UI and the stored records
  have to say "no data, or not allowed" on iOS.
- **The prototype is off by default.** The card shows only in builds with
  `VITE_EXO_HEALTH_SPIKE=true`. Only Android debug builds declare health permissions, and only iOS
  Debug builds have the HealthKit code and entitlements. A release build of either app asks for
  nothing and declares nothing, and `manifest.json` is unchanged.
- **Storage is a stand-in.** Summaries are written under the existing `connectors/` KV grant, which
  the private agent's transcript delegation can also read. A shipped version needs its own `health`
  permission ([Storage and permissions](#storage-and-permissions)).
- **Both stores need paperwork before anything ships**: a published privacy policy (Exo has none),
  App Store guideline 5.1.3 and HealthKit review, the Google Play Health apps declaration and Health
  Connect permission justifications, and privacy manifest / Data safety updates.

**Recommendation:** build it, in this order: privacy policy and a dedicated `health` permission
first, then Android (daily steps, read when the app opens) to internal testing, then iOS once
enrollment lands. Leave background sync for a second step. Details in
[Recommendation](#recommendation).

## What the spike built

| Piece | Where |
|---|---|
| Android plugin `Health` (Java, `androidx.health.connect:connect-client` 1.1.0) | `mobile/android/app/src/main/java/xyz/tinycloud/exo/health/`: `HealthPlugin.java` (availability, permissions, settings), `HealthConnectReader.java` (reads, sample data), `Suspend.java` (Kotlin `suspend` from Java), `HealthPermissionsRationaleActivity.java`; registered in `MainActivity` |
| Android manifest, debug builds only | `mobile/android/app/src/debug/AndroidManifest.xml`: health permissions, `<queries>`, the privacy-policy activity and `activity-alias` Health Connect requires |
| iOS plugin `Health` (Swift, HealthKit), Debug only | `mobile/ios/App/App/HealthPlugin.swift` (inside `#if EXO_HEALTH`), registered in `ExoBridgeViewController` |
| iOS entitlements, Debug only | `mobile/ios/App/App/App.entitlements`, wired by `CODE_SIGN_ENTITLEMENTS` in the Debug configuration; `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription` in `Info.plist` |
| JS contract | `frontend/src/lib/health/nativeHealth.ts` |
| Storage | `frontend/src/lib/health/healthStore.ts` |
| Dev-only UI | `frontend/src/chat/HealthSpikeSection.tsx`, lazy-loaded by `ConnectorsPage` only when `VITE_EXO_HEALTH_SPIKE=true` (a normal build has `HealthSpikeSection=null` and no chunk) |
| CI | `.github/workflows/mobile.yml`: non-gating HealthKit steps after the iOS smoke test; `mobile/scripts/ios-health-probe.sh`. `ios-build.yml`: the Release archive check fails if the binary links HealthKit |

### The plugin contract

Both platforms implement the same methods. They do not report the same things, and the contract
says so instead of hiding it.

| Method | Android (Health Connect) | iOS (HealthKit) |
|---|---|---|
| `availability()` | `available`, `needs_update` (Android 9-13, outdated Health Connect app), `unavailable` (`os_too_old`, `not_installed`); `permissionsDeclared` (false in release builds); background and history read features | `available` / `unavailable` (`device_unsupported`) from `HKHealthStore.isHealthDataAvailable()` |
| `authorizationStatus()` | per type `granted`, `denied` (asked, not granted), `not_determined` (never asked); `readStateKnowable: true` | per type `not_determined` (never asked) or `unknown` (asked; the answer is private); `readStateKnowable: false` |
| `requestAuthorization({ types, background, sampleWrite })` | Health Connect's permission screen through `PermissionController.createRequestPermissionResultContract()` | HealthKit's Health Access sheet through `requestAuthorization(toShare:read:)` |
| `readDailySummaries({ days, types })` | `aggregateGroupByPeriod` (steps, heart rate) and sleep sessions | `HKStatisticsCollectionQuery` (steps, heart rate) and sleep samples |
| `insertSampleData()` | development only: a week of steps, sleep, heart rate written as Exo | same, in HealthKit |
| `openSettings()` | Health Connect's page for Exo, or Play to update Health Connect | opens the Health app (iOS has no deep link to an app's Health access) |
| `enableBackgroundDelivery()` | rejects `not_supported` (no push in Health Connect) | `HKObserverQuery` + `enableBackgroundDelivery(.hourly)`, emits `healthDataChanged` |

A summary day is `{ date, steps, sleepMinutes, sleepBlocks, heartRate: { min, avg, max }, sources }`
in the device's time zone, oldest first. Both platforms use the same rules:

- **Steps and heart rate**: the OS's own daily aggregate. HealthKit merges iPhone and Watch samples;
  Health Connect de-duplicates by the user's app priority list. Do not sum sources yourself.
- **Sleep**: the union of the asleep intervals of the night, so two apps recording the same night
  count once. A night belongs to the day it ends: an interval counts for day D when it ends between
  18:00 on D-1 and 18:00 on D. iOS uses the asleep sleep-analysis values (unspecified, core, deep,
  REM); Android uses each session minus its awake stages (the whole session when it has none).
- **`sources`**: the apps (Android package names) or HealthKit sources (bundle ids) that recorded
  the day. Exo can see which apps write health data.

### Try it

Android (emulator or phone, Android 9+; Health Connect is part of the platform from Android 14):

```sh
bun install && bun run build:packages
VITE_EXO_HEALTH_SPIKE=true bun run build:frontend
cd mobile && bunx cap sync android && cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

With the live-reload setup in `mobile/README.md`, set `VITE_EXO_HEALTH_SPIKE=true` on the dev server
instead. Sign in, open Connectors → Sources: the **Health (development preview)** card is under Voice
notes. With no tracker, tap **Allow sample data**, then **Add sample data**, then **Read last 7 days**
and **Save to my space**.

iOS needs a Debug build signed by a team whose App ID has HealthKit (after enrollment), or the
simulator.

## Android: Health Connect

### Build setup

- **minSdk.** `connect-client` 1.1.0 (the current stable; 1.2.0 is in alpha) declares minSdk 26, the
  app 24. The main manifest has `<uses-sdk tools:overrideLibrary="androidx.health.connect.client"/>`
  and the plugin calls the library only after `getSdkStatus` says Health Connect is available, which
  needs Android 9 (API 28). Raising the app's minSdk to 26 removes the override. Voice-note
  transcription already needs 26, so that is a reasonable product call, but not this spike's.
- **compileSdk 36** is fine for 1.1.0.
- **Java Health Connect plugin.** The app now has a Kotlin Gradle plugin for other native code, but
  this Health Connect spike remains Java. Every Health Connect call is a Kotlin `suspend` function.
  From Java it is a method with a trailing `Continuation`. `Suspend.java` runs it with
  `kotlinx.coroutines.future.FutureKt.future` and waits on the plugin's own worker thread.
  `kotlinx-coroutines-android` is declared explicitly because connect-client's coroutines are a
  runtime-only dependency.
- **API 24/25 trap.** Capacitor reflects over every method a plugin class declares
  (`getDeclaredMethods`). A `java.time` type in any signature would throw `NoClassDefFoundError` at
  app start on Android 7, where `java.time` does not exist. All `java.time` code is in
  `HealthConnectReader`, which is only created after the availability check.
- **Release size.** connect-client, its protobuf, Guava, coroutines and the Kotlin stdlib add
  **1.55 MB** to the release APK (6.04 → 7.59 MB, measured locally) because R8 is off. The library
  also merges an exported `HealthDataSdkService` into every build. Shipping should turn R8 on, or keep
  the dependency out of release builds.
- **Lint.** `lintDebug` has no new errors (it flagged `HealthConnectClient.DEFAULT_PROVIDER_PACKAGE_NAME`
  as library-private; the plugin has its own constant).

### Manifest (debug builds only)

Everything Health Connect needs is in `src/debug/AndroidManifest.xml`, so it merges into debug
builds only. A release AAB declares no health permission, which keeps it out of Play's Health apps
review until we decide to ship. Moving these entries to `src/main` is part of shipping.

- `android.permission.health.READ_STEPS`, `READ_SLEEP`, `READ_HEART_RATE`.
- `READ_HEALTH_DATA_IN_BACKGROUND`, so the spike can ask for it and report it. Nothing reads in the
  background yet.
- `WRITE_STEPS`, `WRITE_SLEEP`, `WRITE_HEART_RATE`, only for the sample-data helper.
- `<queries><package android:name="com.google.android.apps.healthdata"/></queries>`: package
  visibility for the Health Connect app on Android 11-13. Without it `getSdkStatus` reports Health
  Connect missing.
- **The privacy-policy intents.** Health Connect refuses a permission request (no screen, nothing
  granted) from an app that does not handle them:
  - Android 13 and lower: an activity with action `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`;
  - Android 14+: an `activity-alias` with action `android.intent.action.VIEW_PERMISSION_USAGE`,
    category `android.intent.category.HEALTH_PERMISSIONS`, guarded by
    `android.permission.START_VIEW_PERMISSION_USAGE`.

  Both point at `HealthPermissionsRationaleActivity`, which shows placeholder text. Play expects
  this screen to be, or link to, the app's privacy policy.

### Permission flow

1. `availability()` calls `HealthConnectClient.getSdkStatus(context)`:
   - `SDK_AVAILABLE`: go on;
   - `SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED` (Android 9-13): `openSettings()` opens Play at
     `market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding`;
   - `SDK_UNAVAILABLE`: below Android 9, or Android 9-13 without the Health Connect app.
2. `requestAuthorization()` checks that every permission is declared in this build (else
   `not_declared`), remembers what it asked for, and starts the contract's intent with
   `startActivityForResult`. The contract's result lists only what that screen granted, so the
   plugin reports `getGrantedPermissions()` instead.
3. Health Connect's screen lists Exo and the requested types with a toggle each and "Allow all".
   The privacy-policy link on it opens `HealthPermissionsRationaleActivity`.
4. Background reading is a separate, later prompt (`background: true`).

Health Connect cannot tell "refused" from "never asked". The plugin keeps the set it has requested
in SharedPreferences: requested and not granted is `denied`. Google's guidance is that after two
refusals the screen is no longer shown and the user has to grant access in Health Connect's own
settings. The UI needs an "Open Health Connect" fallback for that, which `openSettings()` provides.

**Exact strings.** Exo controls only its rationale screen (`HealthPermissionsRationaleActivity.TEXT`,
title "Exo and Health Connect"). Health Connect's own dialog copy differs by version and is to be
captured on the emulator (see [Device checks](#device-checks-android-emulator)).

### What Android lets the app see

- Exactly which read permissions are granted (`getGrantedPermissions`).
- Whether Health Connect is installed, needs an update, or is missing, and whether this Health
  Connect supports background and history reads (`getFeatures()`).
- Which apps wrote the data (`DataOrigin` package names per aggregate and record).
- **Reads only in the foreground** unless `READ_HEALTH_DATA_IN_BACKGROUND` is granted (feature
  `FEATURE_READ_HEALTH_DATA_IN_BACKGROUND`, Android 15 and newer Health Connect modules). A read from
  the background without it throws.
- **History:** data from up to 30 days before the first grant, unless `READ_HEALTH_DATA_HISTORY` is
  granted (`FEATURE_READ_HEALTH_DATA_HISTORY`).
- Health Connect enforces rate limits on reads. Daily aggregates for 7 days are three calls.

### Background on Android

There is no observer callback. Background sync would be a periodic WorkManager job that holds
`READ_HEALTH_DATA_IN_BACKGROUND`, calls `getChanges(token)` (a token from `getChangesToken`, stored
on the device), re-aggregates the changed days, and writes them to TinyCloud from native code (the
WebView is not running). Tokens expire after 30 days unused; a stale token means a full re-read.
Background and history permissions each need their own justification in the Play declaration.

## iOS: HealthKit

### Build setup and gating

- `HealthPlugin.swift` is inside `#if EXO_HEALTH`. Only the Debug configuration sets that Swift
  condition (`SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG EXO_HEALTH"`) and
  `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`. A Release build (the TestFlight archive) has no
  HealthKit code, no `import HealthKit` and no entitlements file. `ios-build.yml` now fails the
  Release archive check if the binary links HealthKit.
- Why Debug only: the TestFlight export signs with an App Store profile for `xyz.tinycloud.exo`, and
  that App ID has no HealthKit capability. An entitlement the profile lacks fails the export. App
  Review also expects HealthKit to be visible in the app and its description (guideline 2.5.1).
- The unsigned CI builds (`CODE_SIGNING_ALLOWED=NO`, the simulator smoke test and the Release
  archive) build fine with the entitlements file set: with signing off, Xcode does not process it.
- `App.entitlements`:
  - `com.apple.developer.healthkit` = true;
  - `com.apple.developer.healthkit.access` = empty array (no clinical health records);
  - `com.apple.developer.healthkit.background-delivery` = true (required for background delivery
    since iOS 15).
- `Info.plist` (all builds; harmless without the entitlement):
  - `NSHealthShareUsageDescription`: "Exo reads the steps, sleep and heart rate you allow and saves
    a daily summary to your own TinyCloud space. It never uses health data for advertising."
  - `NSHealthUpdateUsageDescription`: "Exo's development preview can add sample steps, sleep and
    heart rate to Health for testing. Exo never writes health data otherwise." Drop it, and the
    sample writer, before shipping (see 5.1.3(ii) below).

### Permission flow

1. `availability()`: `HKHealthStore.isHealthDataAvailable()` (false on iPads before iPadOS 17).
2. `authorizationStatus()`: `getRequestStatusForAuthorization(toShare: [], read: [type])` per type.
   `shouldRequest` is `not_determined`, `unnecessary` is `unknown`. Without the entitlement this call
   fails ("Missing com.apple.developer.healthkit entitlement"), so it doubles as an entitlement check.
3. `requestAuthorization()`: `requestAuthorization(toShare:read:)` shows the Health Access sheet,
   once per type: "“Exo” would like to access and update your Health data.", "Turn On All", a toggle
   per type under "Allow “Exo” to read", "App Explanation: " plus `NSHealthShareUsageDescription`
   (and `NSHealthUpdateUsageDescription` for writes), and "Allow" / "Don't Allow" (exact capture in
   [iOS Simulator in CI](#ios-simulator-in-ci)). Completion `success == true` only means the request
   was handled.
4. **One sheet at a time.** HealthKit presents its sheet on whatever is on screen. A second
   `requestAuthorization` made while the previous sheet is still animating away is never shown
   (UIKit logs "Attempt to present <HKHealthPrivacyHostAuthorizationViewController> on
   <HKHealthPrivacyHostAuthorizationViewController>") and its completion never runs, so the JS promise
   hangs forever. The CI probe hit exactly this when it asked for write access right after read
   access. The plugin now waits until nothing is presented before asking, and again before reporting.
5. Later changes happen outside the app: Settings → Health → Data Access & Devices → Exo, or the
   Health app → profile → Apps → Exo. `openSettings()` can only open the Health app.

### What iOS lets the app see

- Whether it has asked for a type. **Not whether it may read it.** A denied read type returns no
  samples, exactly like a type with no data (Apple does this so an app cannot infer that a user has,
  say, a condition they chose to hide). So every null from iOS means "no data, or not allowed". The
  JS contract marks this with `readStateKnowable: false`, the card says it, and the stored record
  carries it.
- Write (share) status is visible (`authorizationStatus(for:)`), which is what `sampleWrite` reports.
- Which sources (bundle ids: iPhone, Watch, apps) recorded each day.
- **Nothing while the phone is locked**: HealthKit's store is protected data, and reads in the
  background while locked fail with `errorDatabaseInaccessible`. Background sync must cope.
- No 30-day history limit.

### Background delivery

`enableBackgroundDelivery()` shows the moving parts:

- an `HKObserverQuery` per type, and `enableBackgroundDelivery(for:frequency:)`. Steps are capped at
  `.hourly` whatever the app asks for, and iOS may defer further (battery, Low Power Mode);
- the background-delivery entitlement;
- the observer's completion handler must be called on every path. After three misses HealthKit backs
  off.

A real sync needs more than the spike: register the observers in
`application(_:didFinishLaunchingWithOptions:)` (HealthKit relaunches the app in the background and
delivers only to observers that exist), read with an `HKAnchoredObjectQuery` (anchor kept on the
device), and write to TinyCloud natively, because the WebView may not run in a background launch.
Exo's TinyCloud session lives in the WebView today, so native background writes need a native
session (or a delegated key) first. That is the largest piece of background work.

### iOS Simulator in CI

Apple enrollment is still processing: no team, so no provisioning profile can carry HealthKit, and no
device build is possible. The question was whether the simulator needs one. It does not. The Mobile
workflow's iOS job ([PR #122](https://github.com/TinyCloudLabs/tinychat/pull/122)) runs the same Debug
app two ways on an iPhone 17 Pro simulator, iOS 26.5, Xcode 26.6:

| Build | Entitlements in the app | `authorizationStatus()` | Health sheet |
|---|---|---|---|
| Unsigned (`CODE_SIGNING_ALLOWED=NO`, the existing smoke test) | none: Xcode skips entitlement processing | rejected, `not_authorized`: "Missing com.apple.developer.healthkit entitlement. [com.apple.healthkit 4]" | never shown |
| Ad-hoc signed (`CODE_SIGN_IDENTITY=-`, "Sign to Run Locally", no team, no profile) | in `__TEXT,__entitlements`: Xcode writes `App.app-Simulated.xcent` from `App.entitlements` and links it in (`-sectcreate __TEXT __entitlements`); the signature itself carries none | all three types `not_determined` | **shown** |

So HealthKit in the simulator only needs the entitlements embedded, which any local "Sign to Run
Locally" build does. `CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=` is
enough on the command line. The unsigned smoke test keeps passing; its summary now reports the Health
plugin's answer without gating on it.

The sheet the ad-hoc build gets for the read-only request (the product's request), as captured:

- title "Health Access", then "Health" and "“Exo” would like to access and update your Health
  data." (the same sentence for a read-only request);
- a "Turn On All" button;
- "Allow “Exo” to read" with a toggle each for "Heart Rate", "Sleep" and "Steps" (alphabetical, with
  the Health app's icons);
- "App Explanation: " followed by `NSHealthShareUsageDescription`, then a note on background reads
  ("… General > Background App Refresh");
- "Allow" (disabled until a toggle is on) and "Don't Allow".

The write request (`sampleWrite`) gets the same sheet with "Allow “Exo” to write" first and
`NSHealthUpdateUsageDescription` as its explanation.

**End to end in the simulator.** The CI probe (`mobile/scripts/ios-health-probe.sh`) launches the
ad-hoc build with `EXO_HEALTH_PROBE=1`, so `ExoBridgeViewController` drives the plugin over the bridge
the way the web app does and logs each step. The Health sheet is a remote view that AXe's
accessibility queries cannot see ("No translation object returned for simulator"), so the script
answers it by screen position (Turn On All, then Allow), with retries. The run on `2cb8a23`
([job](https://github.com/TinyCloudLabs/tinychat/actions/runs/37169460944), artifact
`exo-ios-health-<sha>`: screenshots, `probe.jsonl`, `entitlements.txt`):

| Step | Result |
|---|---|
| `availability()` | `available` |
| `authorizationStatus()` before | steps, sleep, heart rate `not_determined` |
| `requestAuthorization()` (read only), sheet answered | all three `unknown`: asked, answer hidden. Never "granted", even though every toggle was on |
| `requestAuthorization({ sampleWrite: true })`, second sheet answered | `sampleWrite: "granted"` (write status *is* visible) |
| `insertSampleData()` | 60 samples saved as Exo |
| `readDailySummaries({ days: 7 })` | 7 days; for example 2026-10-03: 5,974 steps, 460 min asleep (1 block), heart rate 65 / 77 / 90; `sources: ["xyz.tinycloud.exo"]`; today null (the samples are later in the day) |
| `enableBackgroundDelivery({ types: ["steps"] })` | `enabled: ["steps"]`, frequency `hourly`: the background-delivery entitlement is accepted too |
| `readDailySummaries({ days: 3, types: ["steps"] })` | only `steps` and `sources` per day |

What this proves and what it does not:

- Proven: the entitlements, usage strings, plugin registration, authorization request and status
  reporting, HealthKit writes, `HKStatisticsCollectionQuery` daily steps and heart rate, the sleep
  union, and background-delivery registration, all through the Capacitor bridge, on iOS 26.5.
- Not proven: anything on a device. The simulator is lenient about provisioning: a device build needs a
  profile from a team whose App ID has HealthKit, which needs the Apple enrollment. Also unproven:
  background wakes (the simulator never delivers them), real Watch/iPhone data and source merging,
  locked-device behavior, and "Don't Allow" (the probe always allows; by HealthKit's design the result
  would be the same `unknown` and null reads).
- The automation is a spike tool. The tap positions are measured for the iOS 26 sheet on an iPhone 17
  Pro and will break when Apple moves the buttons. The CI steps are `continue-on-error`: they never fail
  the job. Keep or drop them; the smoke test does not depend on them.

The probe also found a real bug: a second `requestAuthorization` made while the first sheet was
still dismissing was never shown and its promise never settled (see "One sheet at a time" above). The
plugin now waits for the screen to be clear.

## What the app can and cannot observe

| | Android (Health Connect) | iOS (HealthKit) |
|---|---|---|
| Health store present | yes (`getSdkStatus`: available / needs update / unavailable) | yes (`isHealthDataAvailable`) |
| Read permission granted? | **yes**, exactly | **no**; only "asked" vs "not asked" |
| Refused vs never asked | no (the plugin keeps its own record) | "not asked" only |
| Write permission granted? | yes | yes |
| Which apps/devices wrote the data | yes (package names) | yes (bundle ids) |
| Read in the background | only with `READ_HEALTH_DATA_IN_BACKGROUND` (newer Health Connect) | via background delivery; not while locked |
| Push when data changes | no; poll the Changes API | yes, `HKObserverQuery` (steps at most hourly) |
| History | 30 days before the first grant, unless `READ_HEALTH_DATA_HISTORY` | everything |

## Storage and permissions

### What the prototype does

`saveHealthDailySummaries` writes one KV record per day:

```
{APP_ID}/connectors/exo-health/{healthkit|health_connect}/daily/{YYYY-MM-DD}
{ "schema": "xyz.tinycloud.exo.health.daily/v0", "date", "timeZone", "platform", "source",
  "steps", "sleepMinutes", "sleepBlocks", "heartRate": { "min", "avg", "max" },
  "dataSources": [...], "readStateKnowable", "readAt" }
```

- It reuses the `tinycloud.kv` grant on `connectors/` that `manifest.json` already has (voice notes
  do the same), so the spike needs no manifest change. `manifest.json` is unchanged in this PR.
- Keyed by source, so an iPhone and an Android phone never overwrite each other.
- Each save overwrites the day: today's count grows, and a watch that syncs late changes earlier days.
- Days with no value at all are not written. Writes are sequential (TinyCloud drops concurrent
  responses on one space).

**Why it must not ship this way.** `connectors/` is the meetings grant. The private agent's
transcript delegation (`frontend/src/lib/agentDelegation.ts`, `TRANSCRIPT_PERMISSIONS`, mirrored by
the backend's courier ceiling in `backend/src/routes/agent.ts`) is `tinycloud.kv` get + list on all of
`xyz.tinycloud.tinychat/connectors/`. A user who lets the agent read meeting transcripts would also be
letting it read health data, under a consent that says "read meeting transcripts". Health data needs
its own grant and its own consent line.

### What a real permission looks like

Add a dedicated SQL database (and, only if raw samples are ever kept, a KV prefix) to
`manifest.json`:

```json
{
  "service": "tinycloud.sql",
  "path": "health",
  "actions": ["read", "write", "schema"],
  "description": "Store daily health summaries (steps, sleep, heart rate) that you allow Exo to read from Apple Health or Health Connect, in your space's SQL database."
}
```

- It resolves to `xyz.tinycloud.tinychat/health`, outside the `connectors/` prefix, so no existing
  delegation covers it. Letting the agent use health data becomes its own explicit grant (read-only on
  `…/health`) with its own consent copy.
- Existing users have to re-consent to the new manifest permission. Ship it together with the
  feature, not ahead of it.
- Keep `defaults: false`, like every other entry.

### Data model proposal

One SQL table in the `health` database, one row per day, metric and source:

```sql
CREATE TABLE IF NOT EXISTS health_daily (
  id           TEXT PRIMARY KEY,   -- uuid
  day          TEXT NOT NULL,      -- YYYY-MM-DD in time_zone
  metric       TEXT NOT NULL,      -- steps | sleep_minutes | heart_rate_min | heart_rate_avg | heart_rate_max
  value        REAL,               -- NULL: read, nothing there (iOS: or not allowed)
  unit         TEXT NOT NULL,      -- count | min | bpm
  source       TEXT NOT NULL,      -- healthkit | health_connect
  device_id    TEXT NOT NULL,      -- per install, so two phones on one platform stay apart
  time_zone    TEXT NOT NULL,
  data_sources TEXT,               -- JSON array: apps/devices that recorded it
  state_known  INTEGER NOT NULL,   -- 0 on iOS: a NULL may be a refusal
  read_at      TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

- Long format, so a new metric (resting heart rate, active energy, workouts) is new rows, not a
  migration.
- The TinyCloud SQL authorizer allows no `UNIQUE` or `CREATE INDEX`, so upserts are
  select-then-update on (day, metric, source, device_id), sequentially, as `connectorStore` does.
- **Daily aggregates only**, no raw samples: the least data that answers "how many steps this week",
  and much less to explain in privacy answers. Add a raw table only for a feature that needs it.
- Never sum across sources: each OS already merges its own. With two phones, show both or let the
  user pick one.
- Sync cursors (HealthKit anchors, Health Connect change tokens) stay on the device; they mean nothing
  elsewhere.
- Deletion: "Delete my health data" removes the rows. Turning access off in the OS stops new reads but
  does not delete what is stored; the UI and the privacy policy must say so.

## Store review

### App Store (HealthKit)

[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), verbatim:

> **5.1.3 (i)** Apps may not use or disclose to third parties data gathered in the health, fitness,
> and medical research context—including from the Clinical Health Records API, HealthKit API, Motion
> and Fitness, MovementDisorder APIs, or health-related human subject research—for advertising,
> marketing, or other use-based data mining purposes other than improving health management, or for
> the purpose of health research, and then only with permission. […] You must disclose the specific
> health data that you are collecting from the device.
>
> **5.1.3 (ii)** Apps must not write false or inaccurate data into HealthKit or any other medical
> research or health management apps, and may not store personal health information in iCloud.
>
> **2.5.1** […] HealthKit should be used for health and fitness purposes and integrate with the Health
> app.
>
> **5.1.1 (i)** All apps must include a link to their privacy policy in the App Store Connect metadata
> field and within the app in an easily accessible manner. […]

What that means for Exo:

- **Privacy policy:** required, linked in App Store Connect and in the app, naming the health data
  read, its uses, retention and deletion, and how to revoke. Exo has none yet. This blocks shipping on
  both stores.
- **No ads, no data mining:** Exo has no ads or analytics SDK (`NSPrivacyTracking` is false). Keep
  health data out of any analytics or logs. Sending health data to an LLM (chat about "my sleep this
  week") is disclosure to a third party (the model provider). Do it only for a user-facing feature,
  with explicit consent, and say so in the policy.
- **No iCloud:** Exo uses no iCloud storage, and the summaries go to the user's own TinyCloud space.
  That is the "user-owned storage" story: the space belongs to the user's key, and the app reaches it
  only through the user's delegation. Apple still counts it as data collected (it leaves the device
  and is not end-to-end encrypted), so it goes in the privacy labels. Anything health-related cached
  on the device must be excluded from iCloud backup (`isExcludedFromBackup`); the prototype keeps
  summaries only in memory.
- **No false data:** the spike's `insertSampleData` writes made-up samples into HealthKit. It exists
  only in Debug builds and must never reach a release. Remove it, and `NSHealthUpdateUsageDescription`,
  before shipping.
- **Visible integration (2.5.1):** the App Store description and the app's UI must show the Health
  integration. App Review will want a demo account and a note on where to find it.
- **Capability:** the App ID needs the HealthKit capability (and background delivery if used) before
  a profile can carry the entitlements. Moving the entitlements to Release then works with the
  TestFlight pipeline's automatic signing; verify on the first `validate` run.

### Google Play (Health Connect)

- **Health apps declaration** (Play Console → App content): required once the app declares health
  permissions. Today's release AAB declares none.
- **Health Connect permissions declaration:** one justification per permission, tied to an approved
  use case. Exo's is fitness and wellness (tracking activity, sleep). Background
  (`READ_HEALTH_DATA_IN_BACKGROUND`) and history (`READ_HEALTH_DATA_HISTORY`) each need their own
  justification. Ask only for what a user-facing feature uses: v1 should declare `READ_STEPS` only,
  and no write permission at all.
- **Privacy policy:** "comprehensive and accurate […] easily accessible from your app and Play Store
  listing". The rationale screen (`HealthPermissionsRationaleActivity`) must show or link it.
- **Limited use:** health data only for the user-facing features declared; no ads, no sale, no
  transfer except to provide those features, no human reading without consent.
- **Data safety:** add Health and fitness → Health info and Fitness info: collected, not shared, App
  functionality, encrypted in transit, deletable.

## Privacy manifest impact

The Release app has no HealthKit, so `mobile/ios/App/App/PrivacyInfo.xcprivacy` is unchanged in this
PR. Shipping adds two collected data types, next to the existing entries:

```xml
<!-- Health: HealthKit steps, sleep and heart rate, summarized per day and saved to the user's space. -->
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeHealth</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<!-- Fitness: step counts. -->
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeFitness</string>
	<!-- same Linked / Tracking / Purposes as above -->
</dict>
```

- Apple's "Health" type covers HealthKit data, "Fitness" covers fitness and exercise data. Steps
  arguably fit both; declaring both is the safe reading.
- Linked (the space belongs to the user's DID), not tracking, App Functionality only.
- HealthKit is not a required-reason API: no `NSPrivacyAccessedAPITypes` entry.
- The App Store Connect App Privacy answers must match (Health & Fitness → Health, Fitness), and the
  `mobile/README.md` privacy manifest table gains two rows.

## Recommendation

**Go, in this order:**

1. **Prerequisites (both stores):** publish a privacy policy that covers health data. Add the
   dedicated `health` SQL permission to `manifest.json` with its consent copy, and move storage there.
2. **Android v1:** daily steps only. Read when the app opens and on pull to refresh; no background.
   Declare only `READ_STEPS` in `src/main`, keep the rationale screen (with the policy link), raise
   minSdk to 26 (drops the override) and turn R8 on (or measure the 1.55 MB). Complete the Play
   Health apps and Health Connect declarations, then the internal testing track.
3. **iOS v1, after enrollment:** add HealthKit to the App ID, move the entitlements (minus background
   delivery) to Release, delete the sample writer and `NSHealthUpdateUsageDescription`, update the
   privacy manifest and App Privacy answers, and test on a device through TestFlight. Design every
   screen for "no data, or not allowed".
4. **Then sleep and heart rate**, the same way (one more permission each, and more declaration text).
5. **Background sync last.** It needs a native TinyCloud session (writing without the WebView),
   HKObserverQuery registration at launch plus anchored queries on iOS, and a WorkManager job with the
   background permission on Android. It is the expensive part and the part store reviewers scrutinize
   most.

Not recommended: shipping anything under `connectors/`, writing data into HealthKit or Health
Connect, or using health data in chat without its own consent.

## Device checks (Android emulator)

For whoever runs the emulator (API 36 `google_apis` image; Health Connect is part of the platform on
Android 14+, so nothing to install). Build as in [Try it](#try-it) with `VITE_EXO_HEALTH_SPIKE=true`.

1. **Card visible only with the flag.** A normal build has no Health card in Connectors → Sources; the
   flagged debug build shows "Health (development preview)" under Voice notes, reading "Health Connect
   (Android, API 36): Available." All three types read "Not asked yet".
2. **Permission screen.** Tap **Ask for access**: Health Connect's screen opens listing Steps, Sleep,
   Heart rate (and a separate background-access prompt, since the button asks for it when the
   feature exists). Capture the exact title, body and button strings; they belong in this doc.
3. **Privacy link.** On that screen, the privacy policy link opens "Exo and Health Connect" with the
   placeholder text, and Close returns to it. (If the screen never appears and the call returns at
   once with nothing granted, the `VIEW_PERMISSION_USAGE` alias is not being picked up.)
4. **Partial grant is reported truthfully.** Allow Steps only: the card shows Steps "Allowed", Sleep
   and Heart rate "Not allowed (asked; turned off or refused)".
5. **Sample data.** **Allow sample data** (grant the write toggles), then **Add sample data**: "Added
   N sample records as Exo" (up to 35: three step records, one heart-rate record and one sleep session
   per day; times later today are skipped). Running it twice must not double the numbers on the next read.
6. **Read.** **Read last 7 days**: 7 rows, oldest first, steps between 2,700 and 10,500 a day for the
   allowed type, "—" for types not allowed, "Not read (not allowed): …" listing them, "Recorded by:
   xyz.tinycloud.exo". With all three allowed: sleep between 6 h 40 and 9 h per night and heart rate
   "avg (min–max) bpm".
7. **Save.** **Save to my space**: "Saved N days … under
   `xyz.tinycloud.tinychat/connectors/exo-health/health_connect/daily/`". Optional: confirm one key
   with `tc` (KV get on that prefix plus a date).
8. **Revoke.** **Open Health settings** opens Health Connect's page for Exo. Turn Steps off, come back:
   Steps reads "Not allowed", and a read shows it under "Not read".
9. **Background.** After asking, "Background reads" shows granted / denied (or "unavailable" if this
   Health Connect build lacks the feature). Record which.
10. **No crash on release.** Optional: a release build (no health permissions) shows "Available, but
    this build declares no health permissions" with the flag, and **Ask for access** fails with
    `not_declared` instead of opening anything.
11. Logcat: `adb logcat | grep -i -E 'healthconnect|Health'` during steps 2-6 for anything unexpected.

Sample data lives in Health Connect under Exo's data; delete it there (Health Connect → App
permissions → Exo → Delete app data) after testing.
