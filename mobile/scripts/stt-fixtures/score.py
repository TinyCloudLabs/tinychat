#!/usr/bin/env python3
"""DER with 250 ms collar, overlap scored, and timed word attribution."""
import argparse
import itertools
import json
import math
from pathlib import Path

DURATION = 600.0
STEP = 0.01
COLLAR = 0.25


def rttm(path):
    turns = []
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 8 or parts[0] != "SPEAKER":
            raise ValueError(f"{path}:{line_no}: invalid RTTM")
        start, length = float(parts[3]), float(parts[4])
        end = start + length
        check_range(path, line_no, start, end)
        if length <= 0:
            raise ValueError(f"{path}:{line_no}: nonpositive turn")
        turns.append((start, end, parts[7]))
    return turns


def check_range(path, row, start, end):
    if not (0 <= start <= end <= DURATION + 1e-6):
        raise ValueError(f"{path}:{row}: time [{start}, {end}] outside [0, 600]")


def words(path):
    entries = json.loads(path.read_text())
    for index, word in enumerate(entries):
        check_range(path, index, word["start"], word["end"])
    return entries


def frames(turns):
    result = [set() for _ in range(round(DURATION / STEP))]
    for start, end, speaker in turns:
        for tick in range(max(0, math.floor(start / STEP)), min(len(result), math.ceil(end / STEP))):
            t = (tick + .5) * STEP
            if start <= t < end:
                result[tick].add(speaker)
    return result


def best_mapping(ref, hyp, ref_frames, hyp_frames):
    references = sorted({turn[2] for turn in ref})
    hypotheses = sorted({turn[2] for turn in hyp})
    # The fixture has four speakers. Keep mapping exact and explicit.
    if len(hypotheses) > 8:
        raise ValueError("more than 8 hypothesis speakers")
    counts = {(h, r): 0 for h in hypotheses for r in references}
    for r, h in zip(ref_frames, hyp_frames):
        for hs in h:
            for rs in r:
                counts[(hs, rs)] += 1
    best, best_value = {}, -1
    targets = references + [None] * max(0, len(hypotheses) - len(references))
    for permutation in itertools.permutations(targets, len(hypotheses)):
        score = sum(counts.get((hs, rs), 0) for hs, rs in zip(hypotheses, permutation) if rs is not None)
        if score > best_value:
            best, best_value = dict(zip(hypotheses, permutation)), score
    return best


def diarization_error(ref, ref_frames, hyp_frames, mapping):
    collared = bytearray(len(ref_frames))
    for boundary in [t for start, end, _ in ref for t in (start, end)]:
        for tick in range(max(0, math.floor((boundary - COLLAR) / STEP)),
                          min(len(collared), math.ceil((boundary + COLLAR) / STEP))):
            if abs((tick + .5) * STEP - boundary) < COLLAR:
                collared[tick] = 1
    errors = total = 0
    for tick, (r, h) in enumerate(zip(ref_frames, hyp_frames)):
        if collared[tick]:
            continue
        mapped = [mapping.get(s) for s in h]
        correct = sum(1 for s in mapped if s in r)
        errors += max(len(r), len(h)) - correct
        total += len(r)
    return errors / total if total else 0, errors, total


def word_attribution(ref_words, hyp_words, mapping):
    eligible = correct = 0
    for word in hyp_words:
        middle = (word["start"] + word["end"]) / 2
        candidates = [item for item in ref_words if item["start"] <= middle <= item["end"]]
        if len({item["speaker"] for item in candidates}) != 1:
            continue
        eligible += 1
        correct += mapping.get(word.get("speaker")) == candidates[0]["speaker"]
    return (correct / eligible if eligible else None), correct, eligible


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rttm", type=Path, required=True)
    parser.add_argument("--hyp", type=Path, required=True)
    parser.add_argument("--words", type=Path, required=True)
    parser.add_argument("--hyp-words", type=Path, required=True)
    args = parser.parse_args()
    ref, hyp = rttm(args.rttm), rttm(args.hyp)
    ref_words, hyp_words = words(args.words), words(args.hyp_words)
    ref_frames, hyp_frames = frames(ref), frames(hyp)
    mapping = best_mapping(ref, hyp, ref_frames, hyp_frames)
    der, errors, total = diarization_error(ref, ref_frames, hyp_frames, mapping)
    attribution, matched, eligible = word_attribution(ref_words, hyp_words, mapping)
    print(json.dumps({"DER": der, "error_frames": errors, "reference_frames": total,
                      "word_attribution": attribution, "attributed_words": matched,
                      "eligible_words": eligible, "speaker_mapping": mapping}, sort_keys=True))
