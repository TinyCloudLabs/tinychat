#!/usr/bin/env python3
"""Case/punctuation-normalized word error rate for CC BY 4.0 fixtures."""
import argparse
import re
import unicodedata
from pathlib import Path


def tokens(text):
    text = unicodedata.normalize("NFKC", text).casefold()
    text = "".join(char if char.isalnum() or char.isspace() else " " for char in text)
    return text.split()


def distance(reference, hypothesis):
    row = list(range(len(hypothesis) + 1))
    for index, word in enumerate(reference, 1):
        next_row = [index]
        for j, other in enumerate(hypothesis, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (word != other)))
        row = next_row
    return row[-1]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("hypothesis", type=Path)
    args = parser.parse_args()
    ref = tokens(args.reference.read_text())
    hyp = tokens(args.hypothesis.read_text())
    if not ref:
        parser.error("empty reference")
    errors = distance(ref, hyp)
    print(f"WER={errors / len(ref):.4%} errors={errors} reference_words={len(ref)} hypothesis_words={len(hyp)}")
