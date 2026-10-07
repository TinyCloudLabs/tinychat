#!/usr/bin/env python3
"""Build reproducible LibriSpeech fixtures from test-clean FLACs (CC BY 4.0)."""
import argparse
import array
import json
import random
import subprocess
import wave
from pathlib import Path

RATE = 16000
SEED = 781


def utterances(root: Path, speaker: str):
    files = sorted((root / "LibriSpeech" / "test-clean" / speaker).rglob("*.flac"))[:60]
    if len(files) != 60:
        raise RuntimeError(f"expected 60 utterances for {speaker}, found {len(files)}")
    transcripts = {}
    for file in (root / "LibriSpeech" / "test-clean" / speaker).rglob("*.trans.txt"):
        for line in file.read_text().splitlines():
            key, text = line.split(" ", 1)
            transcripts[key] = text
    result = []
    for file in files:
        pcm = subprocess.check_output(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(file),
                                       "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"])
        samples = array.array("h")
        samples.frombytes(pcm)
        result.append((samples, transcripts[file.stem]))
    return result


def write_wave(path: Path, samples: array.array):
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(samples.tobytes())


def build(root: Path, out: Path):
    first = utterances(root, "1089")
    second = utterances(root, "121")
    joined = array.array("h")
    for samples, _ in first:
        joined.extend(samples)
    write_wave(out / "ls-1089-10m.wav", joined)
    (out / "ls-1089-10m.ref.txt").write_text(" ".join(text for _, text in first) + "\n")

    rng = random.Random(SEED)
    eligible = {
        "1089": [(samples, text) for samples, text in first if 2 * RATE <= len(samples) <= 6 * RATE],
        "121": [(samples, text) for samples, text in second if 2 * RATE <= len(samples) <= 6 * RATE],
    }
    if not all(eligible.values()):
        raise RuntimeError("no 2–6 s utterances for a speaker")
    mix = array.array("h", [0]) * (600 * RATE)
    turns = []
    cursor = 0
    turn = 0
    while cursor < len(mix):
        speaker = "1089" if turn % 2 == 0 else "121"
        samples, text = rng.choice(eligible[speaker])
        end = min(cursor + len(samples), len(mix))
        for index in range(cursor, end):
            mix[index] = max(-32768, min(32767, mix[index] + samples[index - cursor]))
        start_s, end_s = cursor / RATE, end / RATE
        turns.append({"start": round(start_s, 4), "end": round(end_s, 4), "speaker": speaker, "text": text})
        if end == len(mix):
            break
        overlap = rng.uniform(0.3, 0.8)
        cursor = end - round(overlap * RATE)
        turn += 1
    write_wave(out / "ls-alt-2spk-10m.wav", mix)
    (out / "ls-alt-2spk-10m.ref.json").write_text(json.dumps(turns, indent=2) + "\n")
    (out / "ls-alt-2spk-10m.rttm").write_text("".join(
        f"SPEAKER ls-alt-2spk-10m 1 {item['start']:.4f} {item['end'] - item['start']:.4f} <NA> <NA> {item['speaker']} <NA> <NA>\n"
        for item in turns))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    build(args.source, args.output)
