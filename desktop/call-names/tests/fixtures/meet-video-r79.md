QA video capture, Chrome 158 / macOS 26.3, 22 November 2026.

Three connections in the approved test profile: two camera-on speakers and a camera-off observer. Independent synthetic input streams played ten seconds for A, ten seconds silence, ten seconds for B, then over twenty seconds silence. Neither speaker was muted between turns. Audio and video were not saved in this fixture.

The first two tiles use the persistent last-active-speaker state at their root. The observer retains its meter. A stays active through its silence until B starts; B stays active through the final silence. The optional border child is absent before initial activity, so the root is more stable. Root and child disagree for two samples during the handoff (about half a second).

Created with tools/scrub.py from a default-redacted AX probe, mapping the three tile subtrees to Test Guest A, Test Guest B and Alex Example. The live connections shared one QA display name; these distinct fixture names are synthetic, not evidence of live identity separation. Four unrelated control labels outside the fixture privacy allow-list were removed after scrubbing. The complete structural tree and all class-state diffs remain. Class strings are the scrubber's stable hashes, and no raw names, URLs, process IDs or wall-clock times remain.

The three meet-toggle-r79 snapshots are a separate live run: camera off, on, off for the controlled host. After returning from Spotlight, Meet placed that host in the second tile; the synthetic Test Guest A name follows that controlled connection in all three snapshots. The fixture test verifies marker replacement invalidates prior samples even when the tile path stays the same.
