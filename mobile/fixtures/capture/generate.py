#!/usr/bin/env python3
"""Generate/check the normative capture fixtures from expected journal events."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ID = "11111111-1111-4111-8111-111111111111"
STARTED_AT = 1759800000000
FRAME_BYTES = 107
MAX_DURATION_MS = 10_800_000


def canonical(value: object) -> str:
    """ASCII keys, lexical order, compact UTF-8, unescaped slash, one LF."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"


def fixture_for(script: dict) -> tuple[str, str]:
    assert script["role"] == "expected-journal-events"
    assert script["id"] == ID and script["startedAt"] == STARTED_AT
    assert script["frameBytes"] == FRAME_BYTES and script["bitrate"] == 64000
    rate = script["rate"]
    platform = script["platform"]
    segment_frames: dict[int, int] = {}
    segment_started_at: dict[int, int] = {}
    total_frames = 0
    events: list[dict] = []
    for step in script["steps"]:
        event = step["e"]
        at = STARTED_AT + step["at"]
        if event == "segment":
            segment_frames[step["index"]] = 0
            segment_started_at[step["index"]] = step["at"]
        elif event == "hb":
            seg = step["seg"]
            previous = segment_frames[seg]
            assert step["frames"] >= previous
            assert step["frames"] * 1024 * 1000 <= (step["at"] - segment_started_at[seg]) * rate, "AAC frames exceed capture wall interval"
            total_frames += step["frames"] - previous
            segment_frames[seg] = step["frames"]
        audio_ms = total_frames * 1024 * 1000 // rate
        row = {"e": event, "t": at, "a": audio_ms}
        if event == "session":
            row.update(v=1, id=ID, platform=platform, codec="aac-lc", container="adts", rate=rate,
                       channels=1, bitrate=64000, maxDurationMs=MAX_DURATION_MS, source="in_app",
                       owner=None, transitionGen=12, options={"transcriber": "on-device", "identifySpeakers": False})
        elif event == "segment":
            row.update(index=step["index"], file=f"seg-{step['index']:05d}.aac")
        elif event == "input":
            row.update(id="built-in", name=script["inputName"], kind="built_in")
        elif event == "hb":
            row.update(seg=step["seg"], segBytes=step["frames"] * FRAME_BYTES,
                       intent="recording", availability="available")
        elif event == "span_open" or event == "span_close":
            row.update(kind="omitted", reason="interruption")
        elif event == "avail":
            row.update(value=step["value"], reason=step["reason"], gen=step["gen"])
        elif event == "intent":
            row.update(value=step["value"], by="user")
        elif event == "stop":
            row.update(reason="user")
        else:
            raise ValueError(event)
        events.append(row)
    assert total_frames == script["totalFrames"]
    assert [event["e"] for event in events[:4]] == ["session", "avail", "input", "segment"]
    assert events[2]["name"] == script["inputName"]
    heartbeat_times: set[tuple[int, int]] = set()
    for index, event in enumerate(events):
        if event["e"] != "hb":
            continue
        key = (event["seg"], event["t"])
        assert key not in heartbeat_times, "periodic heartbeat must be suppressed at a close"
        heartbeat_times.add(key)
        assert event["intent"] == "recording" and event["availability"] == "available"
        next_event = events[index + 1] if index + 1 < len(events) else None
        closing = next_event is not None and next_event["t"] == event["t"] and (
            next_event["e"] == "span_open" or
            next_event["e"] == "segment" or
            (next_event["e"] == "intent" and next_event["value"] in ("paused", "stopped"))
        )
        if not closing:
            since_segment = event["t"] - (STARTED_AT + segment_started_at[event["seg"]])
            assert since_segment > 0 and since_segment % 2000 == 0, "periodic heartbeat must use segment timer"
    pause = next(i for i, event in enumerate(events) if event["e"] == "intent" and event["value"] == "paused")
    assert events[pause - 1]["e"] == "hb" and events[pause - 1]["t"] == events[pause]["t"]
    assert any(events[i]["e"] == "avail" and events[i]["value"] == "available" and events[i - 1]["e"] == "span_close"
               for i in range(1, len(events)))
    duration_ms = total_frames * 1024 * 1000 // rate
    paused_ms = script["pauseEndAt"] - script["pauseStartAt"]
    span_at_audio_ms = script["framesAtInterruption"] * 1024 * 1000 // rate
    sidecar = {
        "id": ID, "startedAt": STARTED_AT, "durationMs": duration_ms, "mimeType": "audio/mp4",
        "sizeBytes": script["m4aSizeBytes"], "silencedMs": 0, "silencedEvents": 0, "noSignalMs": 0,
        "version": 2, "rev": 1, "wallMs": script["stoppedAt"], "pausedMs": paused_ms,
        "spans": [{"kind": "omitted", "reason": "interruption", "startedAt": STARTED_AT + script["interruptionStartAt"],
                   "endedAt": STARTED_AT + script["interruptionEndAt"], "atAudioMs": span_at_audio_ms, "audioMs": 0}],
        "recovered": False, "endedUnexpectedly": False, "lastHeartbeatAt": STARTED_AT + script["stoppedAt"],
        "exitReason": None, "legacyImport": False, "ownerUnknown": False, "source": "in_app", "owner": None,
        "transitionGen": 12, "options": {"transcriber": "on-device", "identifySpeakers": False},
        "input": {"id": "built-in", "name": script["inputName"], "kind": "built_in"},
        "sampleRate": rate, "bitrate": 64000,
        "ledger": {"spaceId": None, "audio": {"state": "pending", "rowId": None, "at": None},
                   "transcript": {"state": "pending", "outcome": None, "reason": None, "attempts": 0, "nextAttemptAt": None},
                   "transcriptSync": {"state": "pending", "rev": 0, "at": None},
                   "landed": {"state": "none", "eventId": None}, "remote": []},
        "stt": {"state": "waiting_for_model", "pack": None, "engine": None, "segmentsDone": 0,
                "windowsDone": 0, "error": None},
    }
    assert sidecar["durationMs"] == events[-1]["a"]
    assert sidecar["wallMs"] - sidecar["pausedMs"] == 6000
    return "".join(map(canonical, events)), canonical(sidecar)


def decode_adts(header: bytes) -> dict:
    if len(header) != 7:
        raise AssertionError("ADTS header must be seven bytes")
    b = header
    return {
        "sync": (b[0] << 4) | (b[1] >> 4), "id": (b[1] >> 3) & 1,
        "layer": (b[1] >> 1) & 3, "protectionAbsent": b[1] & 1,
        "profile": (b[2] >> 6) & 3, "samplingFrequencyIndex": (b[2] >> 2) & 15,
        "privateBit": (b[2] >> 1) & 1, "channelConfiguration": ((b[2] & 1) << 2) | (b[3] >> 6),
        "originalCopy": (b[3] >> 5) & 1, "home": (b[3] >> 4) & 1,
        "copyrightIdBit": (b[3] >> 3) & 1, "copyrightIdStart": (b[3] >> 2) & 1,
        "frameLength": ((b[3] & 3) << 11) | (b[4] << 3) | (b[5] >> 5),
        "bufferFullness": ((b[5] & 31) << 6) | (b[6] >> 2), "rawDataBlocks": b[6] & 3,
    }


def expected_header(sf_index: int) -> bytes:
    frame_length = FRAME_BYTES
    return bytes((0xFF, 0xF1, (1 << 6) | (sf_index << 2), 1 << 6 | frame_length >> 11,
                  frame_length >> 3 & 0xFF, (frame_length & 7) << 5 | 0x1F, 0xFC))


def compare(path: Path, expected: str, write: bool) -> None:
    if write:
        path.write_bytes(expected.encode("utf-8"))
    else:
        assert path.read_bytes() == expected.encode("utf-8"), f"fixture differs: {path.name}"


def main(write: bool) -> None:
    journals: dict[str, str] = {}
    for platform in ("ios", "android"):
        script = json.loads((ROOT / f"{platform}-input.json").read_text())
        journal, sidecar = fixture_for(script)
        journals[platform] = journal
        compare(ROOT / f"journal-{platform}.jsonl", journal, write)
        compare(ROOT / f"sidecar-v2-{platform}.json", sidecar, write)
        if platform == "ios":
            compare(ROOT / "journal-complete.jsonl", journal, write)
            compare(ROOT / "sidecar-v2.json", sidecar, write)
    ios_lines = journals["ios"].splitlines(keepends=True)
    torn = "".join(ios_lines[:3]) + ios_lines[3][:20]
    compare(ROOT / "journal-torn.jsonl", torn, write)
    header_text = "# AAC-LC, MPEG-4, mono, no CRC, 100-byte payload (frame_length 107)\n"
    for label, sf_index in (("48k-ios", 3), ("44k1-android", 4)):
        header = expected_header(sf_index)
        header_text += f"{label}: {header.hex(' ')}\n"
        actual = decode_adts(header)
        assert actual == {"sync": 0xFFF, "id": 0, "layer": 0, "protectionAbsent": 1,
                          "profile": 1, "samplingFrequencyIndex": sf_index, "privateBit": 0,
                          "channelConfiguration": 1, "originalCopy": 0, "home": 0,
                          "copyrightIdBit": 0, "copyrightIdStart": 0, "frameLength": 107,
                          "bufferFullness": 0x7FF, "rawDataBlocks": 0}
    compare(ROOT / "adts-headers.hex", header_text, write)
    for line, sf_index in zip((ROOT / "adts-headers.hex").read_text().splitlines()[1:], (3, 4)):
        fields = decode_adts(bytes.fromhex(line.split(": ", 1)[1]))
        assert fields == {"sync": 0xFFF, "id": 0, "layer": 0, "protectionAbsent": 1,
                          "profile": 1, "samplingFrequencyIndex": sf_index, "privateBit": 0,
                          "channelConfiguration": 1, "originalCopy": 0, "home": 0,
                          "copyrightIdBit": 0, "copyrightIdStart": 0, "frameLength": 107,
                          "bufferFullness": 0x7FF, "rawDataBlocks": 0}
    for name in ("outbox-entry.json", "outbox-own-lookup.json", "outbox-receipt-upload.json", "outbox-receipt-own-lookup.json", "remote-receipt-open.json", "quarantine-record.json"):
        obj = json.loads((ROOT / name).read_text())
        compare(ROOT / name, canonical(obj), write)
    for name in ("sidecar-v2-ios.json", "sidecar-v2-android.json", "outbox-entry.json", "outbox-own-lookup.json", "outbox-receipt-upload.json", "outbox-receipt-own-lookup.json", "remote-receipt-open.json", "quarantine-record.json"):
        obj = json.loads((ROOT / name).read_text())
        assert (ROOT / name).read_text() == canonical(obj), f"noncanonical {name}"
    assert '"handle":"https://cdn.example.test/uploads/x"' in (ROOT / "outbox-own-lookup.json").read_text()
    for name in ("journal-ios.jsonl", "journal-android.jsonl"):
        for line in (ROOT / name).read_text().splitlines(keepends=True):
            assert line == canonical(json.loads(line)), f"noncanonical {name}"
    torn_lines = (ROOT / "journal-torn.jsonl").read_text().splitlines()
    for line in torn_lines[:-1]:
        json.loads(line)
    try:
        json.loads(torn_lines[-1])
    except json.JSONDecodeError:
        pass
    else:
        raise AssertionError("last journal line must be torn")
    print("capture fixtures: 2 journals, 2 v2 sidecars, torn tail and all ADTS fields verified")


if __name__ == "__main__":
    main(sys.argv[1:] == ["--write"])
