# iOS capture interruptions and input routing

The recording intent and audio availability are separate. Pause closes and syncs the
current AAC segment, stops `AVAudioEngine`, and deactivates `AVAudioSession`; the
microphone indicator should turn off. A call while paused does not restart capture.
Resume from the app activates a new input graph and opens a new segment. Pauses
do not create missing-audio spans or count toward the three-hour recorded-time
limit. Interruption gaps do count toward that limit.

While recording, an interruption closes the segment and opens an omitted-audio
span. Exo schedules a notification for 45 seconds later with the recording ID
and a notification epoch. An ended interruption tries an immediate restart and
then retries at 0.5, 1, 2, 5, 10, and 30-second intervals for up to ten minutes.
Retries change the start generation without changing the notification epoch.
Pause, Stop, Discard, and a successful start invalidate and remove the notice.
A tap only resumes the same recording when its epoch still matches and the
recording still needs input. Notification denial leaves the in-app state as the
way to see and resume an interrupted recording until Live Activity support lands.

Input IDs are `AVAudioSessionPortDescription.uid` values. The selected UID is
saved in `exo.capture.preferredInputUid`. A disconnected preferred input remains
selected; automatic routing is used until it returns. `activeId` comes from
`currentRoute`, so it can differ from the selected ID. Selecting an input while
recording closes the old segment, records a route-change gap, and starts a new
segment. Selecting while paused takes effect at Resume. Media-services reset
while paused is handled by rebuilding at Resume.

## Simulator evidence

`swift test --package-path mobile/ios/Packages/CaptureCore` covers stale start
completion, notification epoch, paused interruption, blocked reasons, and the
recorded-time limit. `EXO_CAPTURE_SMOKE=1 mobile/scripts/ios-simulator-smoke.sh
run …` checks the deterministic transition probe, a live `AVAudioEngine`
start → Pause → simulated call → Resume → Discard sequence, and the AAC journal,
segment, mux, and sidecar path. It also calls `listInputs` and
`selectInput(null)` through the Capacitor bridge. Simulator audio does not prove the indicator,
phone call behavior, or external input routing.

## Vonnegut outcome table — G2 pending

The physical iPhone is reserved. Run these checks with spoken markers once G2
releases it; record the observed state, notification timing, input UID, segment
count, and playback gap in this table.

| Scenario | Expected result | Observed |
| --- | --- | --- |
| Incoming call answered, then ended | Interruption and gap; automatic restart or tap to resume | Pending G2 |
| Incoming call declined | Interruption resolves; new segment | Pending G2 |
| Outgoing call | Interruption resolves; new segment | Pending G2 |
| FaceTime audio | Interruption resolves; new segment | Pending G2 |
| Siri | Interruption resolves or tap notification | Pending G2 |
| Timer alarm | Interruption resolves or tap notification | Pending G2 |
| Apple Music while recording | Route or interruption outcome documented | Pending G2 |
| Full-screen YouTube video | Route or interruption outcome documented | Pending G2 |
| AirPods connect, disconnect, reconnect | Input list and active UID update; segments remain playable | Pending G2 |
| Select AirPods, then built-in microphone | Selected and active UID agree; new segment each switch | Pending G2 |
| Reset Media Services | New segment after rebuild; no lost prior audio | Pending G2 |
| Pause while recording | Orange indicator off within 1 s; Apple Music plays normally | Pending G2 |
| Call answered and ended while paused | Still paused and indicator off; app Resume creates a new segment with no pause span | Pending G2 |
| AirPods connected while paused, then app Resume | New segment uses AirPods | Pending G2 |
| Stop during backoff | Indicator off and stays off | Pending G2 |
| Two-minute call while locked | Notification at about 45 s; tap opens app and resumes | Pending G2 |
| Interruption, Pause, delayed notification tap | Remains paused | Pending G2 |
| Notifications denied | In-app state remains usable; no notification | Pending G2 |
