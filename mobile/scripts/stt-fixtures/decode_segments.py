#!/usr/bin/env python3
"""Decode benchmark VAD cuts with Python sherpa-onnx 1.13.8 for platform parity."""
import argparse
import json
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path, help="16 kHz mono PCM16 WAV")
    parser.add_argument("segments", type=Path, help="Mac or Android metrics JSON")
    parser.add_argument("model", type=Path, help="Parakeet int8 model directory")
    parser.add_argument("output", type=Path)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--blank-penalty", type=float, default=1.0)
    args = parser.parse_args()

    with wave.open(str(args.fixture), "rb") as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
    cuts = json.loads(args.segments.read_text())["vadSegments"]
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(args.model / "encoder.int8.onnx"),
        decoder=str(args.model / "decoder.int8.onnx"),
        joiner=str(args.model / "joiner.int8.onnx"),
        tokens=str(args.model / "tokens.txt"),
        model_type="nemo_transducer", num_threads=args.threads,
        decoding_method="greedy_search", blank_penalty=args.blank_penalty,
        sample_rate=16000, feature_dim=80, dither=0, provider="cpu")
    output = []
    for cut in cuts:
        start, end = (round(cut[key] * 16000) for key in ("start", "end"))
        assert 0 <= start < end <= len(samples)
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples[start:end])
        recognizer.decode_stream(stream)
        output.append({"start": start / 16000, "end": end / 16000,
                       "tokens": list(stream.result.tokens), "text": stream.result.text})
    args.output.write_text(json.dumps(output, indent=2) + "\n")
    print(f"decoded {len(output)} cuts, {sum(len(c['tokens']) for c in output)} tokens")


if __name__ == "__main__":
    main()
