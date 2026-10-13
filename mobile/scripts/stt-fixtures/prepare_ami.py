#!/usr/bin/env python3
"""Rebase AMI reference annotations to the 05:00–15:00 audio crop."""
import argparse
import html
import itertools
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

START, END = 300.0, 900.0


def crop_rttm(source: Path, output: Path):
    rows = []
    for line in source.read_text().splitlines():
        fields = line.split()
        begin, stop = float(fields[3]), float(fields[3]) + float(fields[4])
        begin, stop = max(begin, START), min(stop, END)
        if stop <= begin:
            continue
        fields[3], fields[4] = f"{begin - START:.3f}", f"{stop - begin:.3f}"
        rows.append(" ".join(fields))
    output.write_text("\n".join(rows) + "\n")


def crop_words(archive: Path, rttm: Path, output: Path):
    words = []
    with zipfile.ZipFile(archive) as source:
        for speaker in "ABCD":
            suffix = f"ES2004a.{speaker}.words.xml"
            matches = [name for name in source.namelist() if name.endswith(suffix)]
            if len(matches) != 1:
                raise RuntimeError(f"expected one {suffix}, found {matches}")
            root = ET.fromstring(source.read(matches[0]))
            for node in root.iter():
                if not node.tag.endswith("w") or "starttime" not in node.attrib or "endtime" not in node.attrib:
                    continue
                start, end = float(node.attrib["starttime"]), float(node.attrib["endtime"])
                # A boundary-crossing word has no complete evidence in the crop.
                if start < START or end > END or end <= start:
                    continue
                text = html.unescape("".join(node.itertext())).strip()
                if text and re.search(r"\w", text):
                    words.append({"start": round(start - START, 4), "end": round(end - START, 4),
                                  "text": text, "speaker": speaker})
    # AMI XML uses channel letters; the RTTM uses participant IDs. Resolve that
    # correspondence from annotation overlap, and publish one speaker namespace.
    turns = []
    for line in rttm.read_text().splitlines():
        fields = line.split()
        turns.append((float(fields[3]), float(fields[3]) + float(fields[4]), fields[7]))
    labels = sorted({item[2] for item in turns})
    if len(labels) != 4:
        raise RuntimeError(f"expected four RTTM speakers, found {labels}")
    counts = {(letter, label): 0 for letter in "ABCD" for label in labels}
    for word in words:
        middle = (word["start"] + word["end"]) / 2
        for begin, end, label in turns:
            if begin <= middle < end:
                counts[(word["speaker"], label)] += 1
    candidates = [(sum(counts[(letter, label)] for letter, label in zip("ABCD", permutation)),
                   dict(zip("ABCD", permutation)))
                  for permutation in itertools.permutations(labels)]
    candidates.sort(key=lambda item: item[0], reverse=True)
    best_score, mapping = candidates[0]
    margin = best_score - candidates[1][0]
    print(f"AMI channel mapping: {mapping}; overlap votes={best_score}; margin={margin}", file=sys.stderr)
    if margin <= 0:
        raise RuntimeError("AMI channel mapping is ambiguous")
    for word in words:
        word["speaker"] = mapping[word["speaker"]]
    words.sort(key=lambda row: (row["start"], row["end"], row["speaker"]))
    output.write_text(json.dumps(words, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("rttm", type=Path)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    crop_rttm(args.rttm, args.output / "ami-es2004a-10m.rttm")
    crop_words(args.archive, args.output / "ami-es2004a-10m.rttm", args.output / "ami-es2004a-10m.words.json")
