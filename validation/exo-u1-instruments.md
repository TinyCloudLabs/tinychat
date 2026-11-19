# U1 macOS main-thread validation

Automated guard: `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib recorder::tests::recorder_commands_are_async_and_disk_commands_use_blocking_workers` rejects synchronous recorder commands and checks the eleven disk command boundaries. `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib recorder::engine::tests::retained_wav_is_encoded_off_the_calling_thread_without_deleting_the_source` encodes a fixture WAV on a blocking worker and asserts that its thread differs from the caller.

## Human Instruments check

1. Build and launch this branch's debug Mac app. In Instruments, attach to the Exo process with the **Hangs** instrument (or use **Animation Hitches** plus **Time Profiler** if Hangs is unavailable). Enable main-thread call trees and start recording.
2. With fixture audio rather than the real microphone or speakers, exercise Stop on a 30-minute note, Retry for a failed retained segment, and launch with a retained recovery segment. During each operation, interact with the window. Record each action's timestamp and the maximum main-thread hang duration.
3. Acceptance is **no main-thread hang over 250 ms** in any of the three windows. Inspect any longer sample's main-thread stack; recorder file I/O and `source_mp3`/`normalize_and_import_at` should appear on blocking worker threads, never the main thread. Save the `.trace` and the three measured maxima here for review.

The automated tests prove the command and encode thread boundaries. An Instruments trace from a running app is still needed to measure end-to-end UI hang duration; it was not captured by the fixture tests.
