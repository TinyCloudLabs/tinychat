#!/usr/bin/env python3
"""Turn an ax-probe (or examples/snapshot.rs) JSONL capture into a test fixture that is safe to commit.

    python3 -I tools/scrub.py IN.jsonl OUT.jsonl --name "Real Name=Alex Example" [--name ...] [--snap N|last]
    python3 -I tools/scrub.py IN.jsonl OUT.jsonl --redacted "9:1a2b3c4d=Alex Example" [--redacted ...]

Input: one `meta` line, one `full` line with every node, then `diff` lines (the probe's format).
Text in the input is redacted as «length:hash» except names passed to the probe, numbers, and the labels
of controls and page regions. The output of examples/snapshot.rs is read the same way: its first
`full` line is used, and its `timing`, `result` and `roster` lines are left out.

A capture made without names in clear (the snapshot example's default) shows each name as a
redacted «length:hash». --redacted gives such a mark and the made-up name to put in its place, so
the real name never has to be known or typed.

Kept: the tree (paths and depth), roles, subroles, AX identifiers, live-region fields, interface labels.
  - Labels redacted by the probe are restored when their hash matches KNOWN_LABELS.
  - Class names become stable tokens (`c` + 8 hex digits, the same in every fixture). They are the only
    speaking signal found so far, so phase 2 needs them; they never feed a rule (tree::Node has no field).
Replaced: every real name given with --name, also inside longer labels; a name's single words too.
  Every redacted mark given with --redacted, by its made-up name.
Dropped: DOM ids, every other redacted text, and any text that looks like a URL, a meeting code or id,
  an email address, account, plan or organisation text ("(outside Org)"), or a device id, or that
  contains a word given with --drop. From the meta line: wall-clock times, process ids, the name
  of the capture file (it holds the capture time), the OS build, and every app except the one the
  capture was read from (its bundle id and version stay).

--snap N rebuilds the window as it was after diff N (`last` = after every diff) and writes it as the
`full` line with no diffs. Without --snap the diffs are kept, scrubbed the same way.

Before writing, the output is checked for the real names (and their words), the --drop words,
redaction marks, "@", URLs, "meet.google.com/" and "tinycloud"; any hit stops the script and
nothing is written.
"""
import argparse
import hashlib
import json
import os
import re
import sys

KEEP_NODE_KEYS = {"p", "d", "r", "sr", "id", "t", "desc", "v", "help", "sel",
                  "AXLiveRegionStatus", "AXLiveRegionRelevant"}
TEXT_KEYS = ("t", "desc", "v", "help")

# Interface labels, restored when the probe redacted them. Never a person's name.
KNOWN_LABELS = [
    "(You)", "You", "Meeting host", "Participants", "People", "Search for people", "In call",
    "Captions", "Call controls", "Side panel", "Contributors", "More options", "Adjust view",
    "Your microphone is off.", "Video settings", "Captions and translation",
    "Zoom Meeting", "Participants list",
    # The heading Meet puts in the People list above devices that share a room.
    "Merged audio",
    "Call feature notifications and actions", "Leave call", "Share screen",
    "Camera problem. Show more info", "Microphone problem. Show more info",
    "Raise hand (ctrl + ⌘ + h)",
] + [f"Participants ({n})" for n in range(0, 101)] + [f"Contributors {n}" for n in range(0, 101)]

REDACTED = re.compile(r"«(\d+):([0-9a-f]+)»")
SENSITIVE = [
    re.compile(r"@"),                                            # email, handle
    re.compile(r"://|\bwww\.", re.I),                            # URL
    re.compile(r"\b[a-z0-9-]+\.(com|net|org|io|xyz|us|co|app|dev|ai|me|one)\b", re.I),  # domain
    re.compile(r"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b", re.I),         # Meet meeting code
    re.compile(r"\d{3}[\s-]?\d{3,4}[\s-]?\d{3,4}"),              # Zoom meeting id, phone number
    re.compile(r"\b[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}\b"),            # USB device id
    re.compile(r"account|google drive|subscription|licen[cs]e|€|\$|£|/mo\b", re.I),  # account, plan
    re.compile(r"\(outside [^)]*\)", re.I),                     # organisation of a guest
]
SHORT_OK = re.compile(r"^(\d+(\.\d+)?|AM|PM)$")


def fnv(text):
    h = 2166136261
    for byte in text.encode("utf-8"):
        h = ((h ^ byte) * 16777619) & 0xFFFFFFFF
    return format(h, "x")


KNOWN = {(len(label), fnv(label)): label for label in KNOWN_LABELS}


def class_token(name):
    return "c" + hashlib.sha256(("call-names-fixture:" + name).encode("utf-8")).hexdigest()[:8]


class Scrubber:
    def __init__(self, names, drop=(), redacted=None):
        # Redacted marks that stand for a name, as (length, hash), and the made-up name of each.
        self.redacted = redacted or {}
        pairs = []
        for real, fake in names:
            pairs.append((real, fake))
            real_words, fake_words = real.split(), fake.split()
            if len(real_words) == len(fake_words) > 1:
                pairs.extend(zip(real_words, fake_words))
        # Longest first, so a full name is replaced before its words.
        pairs.sort(key=lambda pair: -len(pair[0]))
        self.pairs = [(re.compile(re.escape(real), re.I), fake) for real, fake in pairs]
        self.forbidden = sorted({word.lower() for real, _ in names for word in [real] + real.split() if len(word) >= 3}
                                | {word.lower() for word in drop})
        self.drop = [re.compile(re.escape(word), re.I) for word in drop]
        self.dropped = 0
        self.restored = 0

    def text(self, value):
        if not isinstance(value, str):
            return None
        match = REDACTED.fullmatch(value)
        if match:
            mark = (int(match.group(1)), match.group(2))
            label = self.redacted.get(mark) or KNOWN.get(mark)
            if label is None:
                self.dropped += 1
                return None
            self.restored += 1
            return label
        for pattern, fake in self.pairs:
            value = pattern.sub(fake, value)
        if any(pattern.search(value) for pattern in SENSITIVE + self.drop):
            self.dropped += 1
            return None
        if len(value) <= 2 and not SHORT_OK.match(value):
            self.dropped += 1
            return None
        return value

    def identifier(self, value):
        if not isinstance(value, str) or not value:
            return None
        for pattern, fake in self.pairs:
            value = pattern.sub(fake, value)
        if any(pattern.search(value) for pattern in SENSITIVE + self.drop):
            return None
        return value

    def node(self, node):
        out = {}
        for key, value in node.items():
            if key == "cls":
                if isinstance(value, list) and value:
                    out["cls"] = [class_token(str(name)) for name in value]
            elif key not in KEEP_NODE_KEYS:
                continue
            elif key in TEXT_KEYS:
                text = self.text(value)
                if text is not None:
                    out[key] = text
            elif key == "id":
                identifier = self.identifier(value)
                if identifier is not None:
                    out[key] = identifier
            else:
                out[key] = value
        return out


def path_key(path):
    head, *rest = path.split(".")
    return [head] + [int(part) for part in rest]


def rebuild(full, diffs, snap):
    state = {node["p"]: node for node in full["nodes"]}
    reached = 0
    for diff in diffs:
        if snap != "last" and diff["snap"] > snap:
            break
        if (diff["changedCount"], diff["addedCount"], diff["removedCount"]) != (
                len(diff["changed"]), len(diff["added"]), len(diff["removed"])):
            sys.exit(f"diff {diff['snap']} was truncated by the probe; cannot rebuild past it")
        for node in diff["changed"] + diff["added"]:
            state[node["p"]] = node
        for path in diff["removed"]:
            state.pop(path, None)
        reached = diff["snap"]
    nodes = [state[path] for path in sorted(state, key=path_key)]
    return nodes, reached


def meta_os(meta):
    """The OS version without its build: "Version 26.3 (Build 25D125)" gives {"os": "26.3"}."""
    match = re.search(r"\d+(?:\.\d+)+", str(meta.get("os") or ""))
    return {"os": match.group(0)} if match else {}


def root_apps(meta):
    """Bundle id and version of the apps a root came from.

    The probe's root labels start with a<app index>. The snapshot example's do not say which app a
    root belongs to, so its app is known only when it looked at one app.
    """
    apps = meta.get("apps") or []
    found = []
    for root in meta.get("roots") or []:
        match = re.match(r"a(\d+)w\d+", str(root))
        if match and int(match.group(1)) < len(apps):
            app = apps[int(match.group(1))]
            entry = {key: app.get(key) for key in ("bundleId", "version") if app.get(key)}
            if entry and entry not in found:
                found.append(entry)
    if not found and len(apps) == 1:
        entry = {key: apps[0].get(key) for key in ("bundleId", "version") if apps[0].get(key)}
        if entry:
            found.append(entry)
    return found


def root_labels(meta, full):
    """The roots of the capture: as the meta line names them, or the paths that have no parent."""
    roots = meta.get("roots")
    if roots:
        return roots
    return sorted({node["p"] for node in full["nodes"] if "." not in node.get("p", ".")})


def redacted_mark(text):
    """"9:1a2b3c4d" or "«9:1a2b3c4d»" as (9, "1a2b3c4d")."""
    match = re.fullmatch(r"«?(\d+):([0-9a-f]+)»?", text.strip())
    if not match:
        sys.exit(f"--redacted needs LENGTH:HASH=NAME, got {text!r}")
    return int(match.group(1)), match.group(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--name", action="append", default=[], metavar="REAL=FAKE",
                        help="a real name and the fake name that replaces it (repeat for each person)")
    parser.add_argument("--redacted", action="append", default=[], metavar="LENGTH:HASH=FAKE",
                        help="a redacted mark that stands for a name, and the made-up name to put in its place")
    parser.add_argument("--drop", action="append", default=[], metavar="WORD",
                        help="drop every text that contains this word, such as an organisation name")
    parser.add_argument("--snap", help="rebuild the window after diff N ('last' = all diffs); drops the diffs")
    args = parser.parse_args()

    names = []
    for item in args.name:
        real, sep, fake = item.partition("=")
        if not sep or not real.strip() or not fake.strip():
            sys.exit(f"--name needs REAL=FAKE, got {item!r}")
        names.append((real.strip(), fake.strip()))

    with open(args.input, encoding="utf-8") as handle:
        lines = [json.loads(line) for line in handle if line.strip()]
    meta = next(line for line in lines if line.get("kind") == "meta")
    full = next(line for line in lines if line.get("kind") == "full")
    diffs = [line for line in lines if line.get("kind") == "diff"]
    attributes = [line for line in lines if line.get("kind") == "attributes"]

    redacted = {}
    for item in args.redacted:
        mark, sep, fake = item.partition("=")
        if not sep or not fake.strip():
            sys.exit(f"--redacted needs LENGTH:HASH=NAME, got {item!r}")
        redacted[redacted_mark(mark)] = fake.strip()

    scrub = Scrubber(names, args.drop, redacted)
    snap = None
    if args.snap is not None:
        snap = "last" if args.snap == "last" else int(args.snap)
        nodes, reached = rebuild(full, diffs, snap)
        full = dict(full, nodes=nodes, snap=reached, count=len(nodes))
        diffs = []

    out = [{
        "kind": "meta",
        "app": meta.get("app"),
        **meta_os(meta),
        "apps": root_apps(meta),
        "roots": root_labels(meta, full),
        "every": meta.get("every"),
        "redacted": True,
        "scrubbed": 2,
        **({"snap": full.get("snap", 0)} if snap is not None else {}),
    }]
    out.append({
        "kind": "full",
        "snap": full.get("snap", 0),
        "t": full.get("t", 0),
        "took": full.get("took"),
        "count": len(full["nodes"]),
        "nodes": [scrub.node(node) for node in full["nodes"]],
    })
    for diff in diffs:
        out.append({
            "kind": "diff",
            "snap": diff["snap"],
            "t": diff.get("t"),
            "took": diff.get("took"),
            "count": diff.get("count"),
            "changedCount": diff["changedCount"],
            "addedCount": diff["addedCount"],
            "removedCount": diff["removedCount"],
            "changed": [scrub.node(node) for node in diff["changed"]],
            "added": [scrub.node(node) for node in diff["added"]],
            "removed": diff["removed"],
        })
    out.extend(attributes)

    text = "".join(json.dumps(line, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n" for line in out)
    lower = text.lower()
    hits = [word for word in scrub.forbidden if word in lower]
    hits += [mark for mark in ("«", "»", "@", "://", "meet.google.com/", "tinycloud") if mark in lower]
    if hits:
        sys.exit(f"refusing to write {args.output}: output still contains {hits}")
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"{args.output}: {len(out[1]['nodes'])} nodes, {len(diffs)} diffs, "
          f"{scrub.restored} labels restored, {scrub.dropped} texts dropped")


if __name__ == "__main__":
    main()
