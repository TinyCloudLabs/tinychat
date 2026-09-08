"""Verify saved actual-Safari browser and local route evidence; no network calls."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
browser = json.loads((root / "browser-audit.json").read_text())
backend = json.loads((root / "backend-audit.json").read_text())
expected = ["success", "of", "eof", "read", "timeout", "stop", "model", "tool", "synthesis", "repair"]
successes = {"success", "model", "tool", "synthesis", "repair"}
assert "Version/18.6 Safari/" in browser["userAgent"]
assert browser["errors"] == browser["unhandled"] == 0
assert browser["blocked"] == []
assert not browser["isRunning"] and browser["canSend"]
assert [turn["mode"] for turn in backend["turns"]] == expected
assert len(browser["messages"]) == len(backend["persisted"]) == 20
assert sum(item["path"] == "/api/agent/chat" for item in backend["traffic"]) == 10
persisted = {item["message"]["id"]: item["message"] for item in backend["persisted"]}
rows = []
for index, turn in enumerate(backend["turns"]):
    user, reply = browser["messages"][index * 2:index * 2 + 2]
    mode = turn["mode"]
    assert user["content"][0]["text"] == f"fixture:{mode}"
    assert turn["settled"] and reply["activity"] is None
    assert persisted[reply["id"]]["content"] == reply["content"]
    assert persisted[reply["id"]]["status"] == reply["status"]
    if mode in successes:
        assert reply["status"]["type"] == "complete"
        assert reply["receipt"]["credits"] == 1 and reply["completion"]
        assert turn["doneWritten"] == 1
    else:
        assert reply["status"]["type"] == "incomplete"
        assert reply["status"]["reason"] == ("cancelled" if mode == "stop" else "error")
        assert reply["receipt"] is None and reply["completion"] is None
        if mode != "of":
            assert "Synthetic partial reply." in json.dumps(reply["content"])
            assert turn["providerCancelled"]
    rows.append({"mode": mode, "includedInNineCases": mode != "of", "status": reply["status"],
                 "commentsWritten": turn["commentsWritten"], "providerCancelled": turn["providerCancelled"],
                 "doneWritten": turn["doneWritten"], "settledMsFromRequestStart": turn["settledAt"]})
wire = "".join(item["text"] for item in browser["arrivals"])
comments = sum(line.startswith(":") for line in wire.splitlines())
assert comments == sum(turn["commentsWritten"] for turn in backend["turns"])
assert "UNCHECKED_DRAFT_MUST_STAY_PRIVATE" not in json.dumps(browser)
assert "UNCHECKED_DRAFT_MUST_STAY_PRIVATE" not in json.dumps(backend["persisted"])
result = {"passed": True, "requiredCasesPassed": 9, "additionalMistypedFixtureCase": 1,
          "totalRequests": 10, "persistedMessages": 20, "browserComments": comments,
          "pageErrors": 0, "unhandledRejections": 0, "canSend": True, "cases": rows}
(root / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
