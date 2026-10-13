# Exo development logs

Development builds write one JSON object per line. Each entry has `at`,
`kind`, and `source_id` (null for session, request, and native bridge events).
Note events use the recording ID as `source_id`. Request paths omit query
strings and variable path segments. Bridge events contain plugin and method
names, duration, and outcome; they never contain arguments or results.
Capacitor's own `loggingBehavior` stays `none` because it cannot redact
secure storage and OpenKey payloads. Release builds do not enable these sinks.

## Desktop (Tauri debug/dev)

```sh
tail -F "$HOME/Library/Logs/xyz.tinycloud.exo/exo-dev.log"
# Filter one recording:
tail -F "$HOME/Library/Logs/xyz.tinycloud.exo/exo-dev.log" | jq -c 'select(.source_id == "RECORDING_ID")'
```

Native recorder, Whisper, and uploader tracing also goes to Tauri's stdout
and this file at info level. The file rotates at about 5 MiB to
`exo-dev.log.1`.

## iOS device build (`xyz.tinycloud.exo.dev`)

The debug app writes to `Library/Logs/exo-dev.log` in its app data container
and mirrors each line to unified logging with subsystem
`xyz.tinycloud.exo.dev`, category `app`. The file can be pulled over Wi-Fi
from a paired device:

```sh
xcrun devicectl list devices
xcrun devicectl device copy from --device DEVICE_ID \
  --domain-type appDataContainer --domain-identifier xyz.tinycloud.exo.dev \
  --source Library/Logs/exo-dev.log --destination ./exo-ios-dev.log
tail -f ./exo-ios-dev.log
```

Run the copy command again to get new lines; the app container file is not a
live stream on the Mac. Its rotated predecessor is
`Library/Logs/exo-dev.log.1`.

## Android debug build

The debug application ID is `xyz.tinycloud.exo.dev`.

```sh
adb devices
adb -s DEVICE_ID logcat -v raw ExoDev:I '*:S'
# For a Wi-Fi debugging session first: adb connect HOST:PORT
```

## Vite web development

Run `bun run --cwd frontend dev` and read the browser DevTools Console.
Every app log line is plain JSON. Production Vite builds do not emit it.
