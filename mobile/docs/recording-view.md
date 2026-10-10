# Recording view (TC-784)

The in-app recorder opens as a full-page view. Minimise leaves the native capture running and exposes its state in the island, rail, sidebar, or header chip. Pause releases the microphone; Resume asks native capture to reacquire it. The timer uses native `audioMs`, so it excludes pauses.

Stop awaits the native commit and immediately shows **Saved on this phone** with playback through `localAudioUrl`. Space upload runs after that receipt appears. A successful upload updates the native audio ledger for owned v2 notes and leaves the local audio in place. Discard is the only action that removes a device copy. Legacy notes with unknown ownership and unowned v2 notes are held for the later ownership flow.

The receipt stays open during playback. The waveform uses 96 level samples, with a flat line while capture is paused or interrupted. The screen uses one column in portrait, two in landscape, and a centred 36 rem column on a portrait tablet. The Live Edge uses the native level signal while the microphone is live.

The native v2 bridge contract and fake are supplied by T1. On-device playback and seeking are part of the G1 joint gate after the native engines are integrated.
