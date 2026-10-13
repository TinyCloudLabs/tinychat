#!/usr/bin/env python3
"""Compare Python and Android sherpa tokens on identical VAD sample ranges."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("python_tokens", type=Path)
    parser.add_argument("android_metrics", type=Path)
    args = parser.parse_args()
    mac = json.loads(args.python_tokens.read_text())
    android = json.loads(args.android_metrics.read_text())["vadSegments"]
    mac_by_cut = {(round(row["start"] * 16000), round(row["end"] * 16000)): row["tokens"] for row in mac}
    android_by_cut = {(round(row["start"] * 16000), round(row["end"] * 16000)): row["tokens"] for row in android}
    common = mac_by_cut.keys() & android_by_cut.keys()
    only_mac = mac_by_cut.keys() - android_by_cut.keys()
    only_android = android_by_cut.keys() - mac_by_cut.keys()
    different = [(cut, mac_by_cut[cut], android_by_cut[cut]) for cut in sorted(common)
                 if mac_by_cut[cut] != android_by_cut[cut]]
    print(f"cuts: python={len(mac)} android={len(android)} shared={len(common)} "
          f"python_only={len(only_mac)} android_only={len(only_android)}")
    print(f"tokens: python={sum(map(len, mac_by_cut.values()))} "
          f"android={sum(map(len, android_by_cut.values()))} mismatched_cuts={len(different)}")
    for cut, left, right in different[:10]:
        first = next((i for i in range(min(len(left), len(right))) if left[i] != right[i]),
                     min(len(left), len(right)))
        print(f"cut={cut} first_difference={first} python={left[first:first+4]} android={right[first:first+4]}")
    if only_mac or only_android or different:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
