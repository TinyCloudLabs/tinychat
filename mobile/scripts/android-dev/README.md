# Android capture emulator harness

The API 24 and 34 AVDs exercise the minimum Android level and a recent level.
The scripts select `arm64-v8a` on Apple Silicon and `x86_64` on x86_64 hosts.
They use `~/Library/Android/sdk` on macOS and `~/Android/Sdk` on Linux unless
`ANDROID_HOME` is set. A visible emulator window and `-allow-host-audio` are
required for a usable microphone; do not run with `-no-window`.

```sh
EXO_AVD_API=24 mobile/scripts/android-dev/create-avd.sh
EXO_AVD_API=34 mobile/scripts/android-dev/create-avd.sh
EXO_AVD_API=34 mobile/scripts/android-dev/start-emulator.sh
ANDROID_SERIAL=emulator-5574 bash -c 'cd mobile/android && ./gradlew --no-daemon :app:connectedDebugAndroidTest'
EXO_AVD_API=24 mobile/scripts/android-dev/start-emulator.sh
ANDROID_SERIAL=emulator-5554 bash -c 'cd mobile/android && ./gradlew --no-daemon :app:connectedDebugAndroidTest'
```

Named ports permit both AVDs to run at once. The `EXO_AVD_API` default is 34;
`EXO_EMULATOR_ARGS` passes extra emulator flags. A boot can take several minutes.
The older Vite, DevTools, and audio injection scripts source `env.sh` too.
