# TC-947 stereo bitrate check

Date: 2026-10-13. Audio was synthesized with macOS `say` into two files; no microphone or speaker capture was used. Left (Samantha): “The design review starts on Thursday morning. I will send the draft agenda to the team. Please check the deployment plan before lunch.” Right (Daniel): “We can test the new recording path tomorrow. The second channel should keep the meeting audio clear. I will review the notes after the call.”

The two 16 kHz channels were joined into one stereo WAV and encoded with `ffmpeg`/libmp3lame at 64 and 128 kb/s. The resulting [64 kb/s](../fixtures/tc947-me-them-64.mp3) and [128 kb/s](../fixtures/tc947-me-them-128.mp3) files are committed fixtures. Each channel was extracted with `ffmpeg -af 'pan=mono|c0=c0'` or `c0=c1`. Whisper Small (`small.pt`, CPU, English specified) transcribed each extracted WAV. WER used lowercase alphabetic tokens and word edit distance divided by reference word count.

| Channel | 64 kb/s WER | 128 kb/s WER | Difference |
| --- | ---: | ---: | ---: |
| Me | 0.0% | 0.0% | 0.0 points |
| Them | 0.0% | 0.0% | 0.0 points |

Both channels meet the one-point criterion. The fixture is short, clean synthetic speech; it does not establish quality on noisy calls, overlapping speech, or hardware captures. The recorder's synthetic PCM import test separately verifies that its own MP3 writer emits stereo at 64 kb/s and preserves a silent right channel.
