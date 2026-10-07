#!/usr/bin/env python3
"""DER with 250 ms collar, overlap scored, and timed word attribution."""
import argparse
import json
import math
import re
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
    counts = {(h, r): 0 for h in hypotheses for r in references}
    for r, h in zip(ref_frames, hyp_frames):
        for hs in h:
            for rs in r:
                counts[(hs, rs)] += 1
    # Exact one-to-one assignment. Most extra local speakers remain unmatched.
    states = {0: (0, {})}
    for hypothesis in hypotheses:
        next_states = {mask: (score, {**mapping, hypothesis: None})
                       for mask, (score, mapping) in states.items()}
        for mask, (score, mapping) in states.items():
            for index, reference in enumerate(references):
                bit = 1 << index
                if mask & bit:
                    continue
                target = mask | bit
                candidate = score + counts[(hypothesis, reference)]
                if target not in next_states or candidate > next_states[target][0]:
                    next_states[target] = candidate, {**mapping, hypothesis: reference}
        states = next_states
    return max(states.values(), key=lambda state: state[0])[1]


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


def window_oracle_mapping(ref, hyp, ref_frames, hyp_frames):
    """Optimistic diagnostic: relabel each 60-second window using its reference."""
    mapping = {}
    for window in range(10):
        begin, end = window * 60, (window + 1) * 60
        local_ref = [turn for turn in ref if turn[0] < end and turn[1] > begin]
        local_hyp = [turn for turn in hyp if turn[0] < end and turn[1] > begin]
        first, last = round(begin / STEP), round(end / STEP)
        mapping.update(best_mapping(local_ref, local_hyp,
                                    ref_frames[first:last], hyp_frames[first:last]))
    return mapping


def word_attribution(ref_words, hyp_words, mapping, ref_frames, mode):
    eligible = correct = 0
    for word in hyp_words:
        if mode == "single-speaker-region":
            first = max(0, math.floor(word["start"] / STEP))
            last = min(len(ref_frames), math.ceil(word["end"] / STEP))
            active = ref_frames[first:last]
            if not active or any(len(frame) != 1 or frame != active[0] for frame in active):
                continue
            reference_speaker = next(iter(active[0]))
        else:
            middle = (word["start"] + word["end"]) / 2
            candidates = [item for item in ref_words if item["start"] <= middle <= item["end"]]
            speakers = {item["speaker"] for item in candidates}
            if len(speakers) != 1:
                continue
            reference_speaker = next(iter(speakers))
        eligible += 1
        correct += mapping.get(word.get("speaker")) == reference_speaker
    return (correct / eligible if eligible else None), correct, eligible


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rttm", type=Path, required=True)
    parser.add_argument("--hyp", type=Path, required=True)
    parser.add_argument("--words", type=Path, required=True)
    parser.add_argument("--hyp-words", type=Path, required=True)
    parser.add_argument("--attribution-mode", choices=["midpoint", "single-speaker-region"],
                        default="midpoint")
    args = parser.parse_args()
    ref, hyp = rttm(args.rttm), rttm(args.hyp)
    ref_words, hyp_words = words(args.words), words(args.hyp_words)
    ref_frames, hyp_frames = frames(ref), frames(hyp)
    mapping = best_mapping(ref, hyp, ref_frames, hyp_frames)
    der, errors, total = diarization_error(ref, ref_frames, hyp_frames, mapping)
    attribution, matched, eligible = word_attribution(
        ref_words, hyp_words, mapping, ref_frames, args.attribution_mode)
    result = {"DER": der, "error_frames": errors, "reference_frames": total,
              "word_attribution": attribution, "attributed_words": matched,
              "eligible_words": eligible, "speaker_mapping": mapping,
              "attribution_mode": args.attribution_mode}
    labels = {turn[2] for turn in hyp}
    if labels and all(re.fullmatch(r"w\d+_speaker_\d+", label) for label in labels):
        oracle = window_oracle_mapping(ref, hyp, ref_frames, hyp_frames)
        oracle_der, oracle_errors, _ = diarization_error(ref, ref_frames, hyp_frames, oracle)
        oracle_attr, oracle_matched, oracle_eligible = word_attribution(
            ref_words, hyp_words, oracle, ref_frames, args.attribution_mode)
        result.update({"per_window_oracle_DER": oracle_der,
                       "per_window_oracle_error_frames": oracle_errors,
                       "per_window_oracle_word_attribution": oracle_attr,
                       "per_window_oracle_attributed_words": oracle_matched,
                       "per_window_oracle_eligible_words": oracle_eligible})
    print(json.dumps(result, sort_keys=True))
