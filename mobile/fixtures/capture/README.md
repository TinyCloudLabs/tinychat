# Capture golden fixtures

`journal-complete.jsonl` has a call gap, a user pause with the mic off, a new segment on resume, and four seconds of recorded audio over eleven seconds of wall time. `journal-torn.jsonl` ends inside a JSON object: readers must ignore the last line. `sidecar-v1.json` must be treated as `ownerUnknown`; `sidecar-malformed.json` goes to quarantine and its audio is probed. The ADTS headers are seven-byte frames with a 100-byte payload.
