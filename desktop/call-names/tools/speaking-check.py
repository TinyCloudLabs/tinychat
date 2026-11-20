#!/usr/bin/env python3
"""Check a live speaking test: compare `snapshot --speaking` output with the tester's timed events.

    python3 -I tools/speaking-check.py SNAPSHOT.jsonl EVENTS.json --speaker host=p1 --speaker third=p2
                                       [--grace 1.0] [--json]

SNAPSHOT.jsonl is the output of `cargo run --release --example snapshot -- --speaking`: its `meta`
line gives the wall-clock start of the recording clock, its `timeline` line the timeline the app
would keep, its `sample` lines the samples.

EVENTS.json is either the tester's own events (a JSON list of {"kind", "wallTime", "speaker", ...}
with "speech_start" and "speech_end" for each turn, as the s56 test wrote them), or a scrubbed
fixture ({"kind": "speaking-events", "events": [{"t", "kind", "turn", "tile"}]}, times relative to
the recording clock); then name each tile: --speaker 0=p1 --speaker 1=p2.

--speaker LABEL=ID says which roster person id (see the `roster` line; use --show-names in your own
test room, with a distinct display name for each connection) spoke for each label of the events.
--speaker LABEL=tile:N names a tile instead (N is its index in the names tick, 0 is the first tile
under the main landmark), for a room where two connections show one display name and so are one
person in the roster and the timeline. Tiles are judged from the samples' preliminary marks, with
the timeline's rules (first "on" to last "on" plus one interval, gaps up to 1 s merged, a lone
sample dropped); the names tick did not confirm those marks, and a tile's index holds only while
the layout does not change. Use either person ids or tiles, not both.

For each turn (speech start to speech end) the owner is the person whose speaking intervals overlap
the speech, and GRACE seconds after it, the most. Per turn: the owner and whether it is right, the
onset (first interval start minus speech start), the end error (end of the last interval that
starts in the turn minus speech end), the share of the speech covered, and the time anybody else
speaks during it. Then the speaking time of anybody in the silences (from GRACE after each speech
end to the next speech start, and before the first), as a share of all silence, and how much of
the test time each speaker's marker was seen.

PASS: every owner right, and "on" covers under 1% of the silence. Exit code 0 on PASS, 1 on FAIL,
2 when an input cannot be used. Only ids, times and counts are printed.
"""
import argparse
import json
import statistics
import sys

MERGE_GAP_MS = 1000


def fail_input(message):
    print(f"speaking-check: {message}", file=sys.stderr)
    sys.exit(2)


def load_snapshot(path):
    meta, timeline, samples = None, None, []
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                fail_input(f"{path}: line {number} is not JSON")
            kind = value.get("kind")
            if kind == "meta" and meta is None:
                meta = value
            elif kind == "timeline":
                timeline = value.get("timeline")
            elif kind == "sample":
                samples.append(value)
    if meta is None:
        fail_input(f"{path}: no meta line; is this `snapshot --speaking` output?")
    return meta, timeline, samples


def tile_spans(samples, default_ms):
    """Per tile ("tile:N"), speaking and seen spans in ms from the samples' marks, by the timeline's rules."""
    tracks = {}

    def close_run(track):
        run = track["run"]
        if run and run[2] >= 2:
            track["speaking"].append([run[0], run[1]])
        track["run"] = None

    for sample in samples:
        if sample.get("kept") is False:
            continue
        at = round(float(sample.get("t", 0)) * 1000)
        period = int(sample.get("intervalMs") or default_ms)
        for tile in sample.get("tiles", []):
            mark = tile.get("mark")
            if mark not in ("on", "off"):
                continue
            track = tracks.setdefault(f"tile:{tile.get('tile')}",
                                      {"speaking": [], "seen": [], "run": None, "view": None})
            view = track["view"]
            if view and at <= view[1] + MERGE_GAP_MS:
                view[1] = max(view[1], at + period)
            else:
                if view:
                    track["seen"].append(view)
                track["view"] = [at, at + period]
            run = track["run"]
            if mark == "on":
                if run and at <= run[1] + MERGE_GAP_MS:
                    run[1] = max(run[1], at + period)
                    run[2] += 1
                else:
                    close_run(track)
                    track["run"] = [at, at + period, 1]
            elif run and at > run[1] + MERGE_GAP_MS:
                close_run(track)
    for track in tracks.values():
        close_run(track)
        if track["view"]:
            track["seen"].append(track["view"])
    return ({key: track["speaking"] for key, track in tracks.items()},
            {key: track["seen"] for key, track in tracks.items()})


def sample_interval_ms(meta, samples):
    """The sample interval: from the meta line, else the median time between samples, else 200 ms."""
    if meta.get("intervalMs"):
        return int(meta["intervalMs"])
    times = sorted(float(sample.get("t", 0)) for sample in samples)
    gaps = [round((b - a) * 1000) for a, b in zip(times, times[1:]) if b > a]
    return int(statistics.median(gaps)) if gaps else 200


def load_turns(path, started_wall):
    """Turns as (label, start, end) in seconds on the recording clock."""
    with open(path, encoding="utf-8") as handle:
        events = json.load(handle)
    if isinstance(events, dict) and events.get("kind") == "speaking-events":
        timed = [(event["t"], event["kind"], str(event.get("tile"))) for event in events["events"]]
    elif isinstance(events, list):
        if not isinstance(started_wall, (int, float)):
            fail_input("the snapshot's meta line has no startedWall")
        timed = [(event["wallTime"] - started_wall, event.get("kind"), str(event.get("speaker")))
                 for event in events if isinstance(event.get("wallTime"), (int, float))]
    else:
        fail_input(f"{path}: not an events file")
    turns, open_turn = [], None
    for t, kind, label in sorted(timed, key=lambda item: item[0]):
        if kind == "speech_start":
            open_turn = (label, t)
        elif kind == "speech_end" and open_turn is not None:
            if open_turn[0] != label:
                fail_input(f"speech of {open_turn[0]} ends as {label}")
            turns.append((label, open_turn[1], t))
            open_turn = None
    if not turns:
        fail_input(f"{path}: no speech_start/speech_end pairs")
    return turns


def overlap(spans, start, end):
    """Seconds of spans (in ms) inside [start, end] (in seconds)."""
    total = 0.0
    for span_start, span_end in spans:
        total += max(0.0, min(span_end / 1000.0, end) - max(span_start / 1000.0, start))
    return total


def check(timeline, turns, speakers, grace, tiles=None):
    """`tiles`: (speaking, seen) per tile, when the speakers are tiles; else the timeline's people."""
    if tiles is not None:
        speaking, seen = tiles
        timeline = timeline or {}
    else:
        speaking = {person: data.get("speaking", []) for person, data in timeline.get("people", {}).items()}
        seen = {person: data.get("seen", []) for person, data in timeline.get("people", {}).items()}
        if timeline.get("self"):
            speaking[timeline["self"]] = timeline.get("self_speaking", [])
    rows, all_right = [], True
    for index, (label, start, end) in enumerate(turns, 1):
        expected = speakers.get(label)
        if expected is None:
            fail_input(f"no --speaker for label {label}")
        window = (start, end + grace)
        overlaps = {person: overlap(spans, *window) for person, spans in speaking.items()}
        owner = max(overlaps, key=overlaps.get) if overlaps and max(overlaps.values()) > 0 else None
        mine = speaking.get(expected, [])
        inside = [span for span in mine if span[1] / 1000.0 > start and span[0] / 1000.0 < end + grace]
        onset = inside[0][0] / 1000.0 - start if inside else None
        end_error = inside[-1][1] / 1000.0 - end if inside else None
        covered = overlap(mine, *window) / (end - start) if end > start else 0.0
        others = sum(value for person, value in overlaps.items() if person != expected)
        right = owner == expected
        all_right &= right
        rows.append({"turn": index, "speaker": expected, "owner": owner, "right": right,
                     "onset_s": None if onset is None else round(onset, 3),
                     "end_error_s": None if end_error is None else round(end_error, 3),
                     "covered": round(covered, 3), "others_s": round(others, 3)})
    silences = [(0.0, turns[0][1])]
    silences += [(turns[i][2] + grace, turns[i + 1][1]) for i in range(len(turns) - 1)]
    silence_total = sum(max(0.0, end - start) for start, end in silences)
    silence_on = sum(overlap(spans, start, end) for spans in speaking.values()
                     for start, end in silences if end > start)
    test_start, test_end = turns[0][1], turns[-1][2]
    seen_share = {person: round(overlap(seen.get(person, []), test_start, test_end)
                                / max(test_end - test_start, 1e-9), 3)
                  for person in sorted(set(speakers.values())) if person != timeline.get("self")}
    share = silence_on / silence_total if silence_total > 0 else 0.0
    passed = all_right and share < 0.01
    return {"pass": passed, "turns": rows, "silence_s": round(silence_total, 3),
            "silence_on_s": round(silence_on, 3), "silence_on_share": round(share, 4),
            "seen_share": seen_share, "mode": timeline.get("mode"),
            "hidden": timeline.get("hidden", []), "breaks": timeline.get("breaks", []),
            "truncated": timeline.get("truncated")}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("snapshot")
    parser.add_argument("events")
    parser.add_argument("--speaker", action="append", default=[], metavar="LABEL=ID",
                        help="the roster person id of a speaker label (or tile number) in the events")
    parser.add_argument("--grace", type=float, default=1.0,
                        help="seconds after each speech end that still belong to the turn (default 1.0)")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args()
    speakers = {}
    for item in args.speaker:
        label, sep, person = item.partition("=")
        if not sep or not label.strip() or not person.strip():
            fail_input(f"--speaker needs LABEL=ID, got {item!r}")
        speakers[label.strip()] = person.strip()
    meta, timeline, samples = load_snapshot(args.snapshot)
    turns = load_turns(args.events, meta.get("startedWall"))
    by_tile = [person.startswith("tile:") for person in speakers.values()]
    if any(by_tile) and not all(by_tile):
        fail_input("use either person ids or tiles (tile:N) for every --speaker, not both")
    if any(by_tile):
        if not samples:
            fail_input(f"{args.snapshot}: no sample lines to judge tiles by")
        tiles = tile_spans(samples, sample_interval_ms(meta, samples))
        result = check(timeline, turns, speakers, args.grace, tiles)
    else:
        if not timeline:
            fail_input(f"{args.snapshot}: no timeline; the run followed no speaking marker")
        result = check(timeline, turns, speakers, args.grace)
    marks = [tile.get("mark") for sample in samples for tile in sample.get("tiles", [])]
    result["samples"] = len(samples)
    result["unknown_marks"] = sum(1 for mark in marks if mark == "unknown")
    result["timed_out"] = sum(1 for sample in samples if sample.get("timedOut"))
    result["dropped"] = sum(1 for sample in samples if sample.get("kept") is False)
    if args.json:
        print(json.dumps(result, indent=1))
    else:
        print(f"mode {result['mode']}, {result['samples']} samples, {result['unknown_marks']} unknown marks, "
              f"{result['timed_out']} timed out, {result['dropped']} dropped")
        print("turn  speaker  owner  right  onset_s  end_error_s  covered  others_s")
        for row in result["turns"]:
            print(f"{row['turn']:>4}  {row['speaker']:>7}  {str(row['owner']):>5}  {str(row['right']):>5}  "
                  f"{str(row['onset_s']):>7}  {str(row['end_error_s']):>11}  {row['covered']:>7}  {row['others_s']:>8}")
        print(f"silence {result['silence_s']} s, on during silence {result['silence_on_s']} s "
              f"({result['silence_on_share'] * 100:.2f}%)")
        print(f"seen during the test: {result['seen_share']}; hidden {result['hidden']}; breaks {result['breaks']}")
        print("PASS" if result["pass"] else "FAIL")
    sys.exit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
