# Local session handoff

“Export this session so the next agent can see how it went” means a **local diagnostic handoff**. Invoke the installed `tinychat_handoff` tool in the intended current conversation. Report the absolute path from its receipt. Publishing or remote sharing requires a separate explicit user request; do not load generic sharing instructions, run `tc share publish`, retry upload authorization, broaden permissions or start sign-in for a local export.

The tool accepts optional short `goal` and `nextAction` notes; omit either when unknown. It reads the current OpenCode session through its native client API and writes a new private mode-0600 Markdown file. It does not select an arbitrary recent session. An existing output path is never overwritten. If native session evidence is unavailable or mismatched, retain the reported failure; do not substitute another conversation or dump a database/history file.

Integration-supplied goal and next-action notes must be short descriptions of the task. Do not paste chat text, commands, authorization responses, provider configuration or credentials into them. The helper withholds recognized sensitive patterns and projects only known fields from observations; it is not a general-purpose secret scrubber for arbitrary documents.

The handoff records:

- The user goal, intended session ID, observed model and candidate/client/CLI versions when available.
- Completed, failed and pending auth, context, actual diagnostics and retrieval stages. A ready auth receipt is not proof that SQL or body access passed.
- Known safe receipt fields and separately measured capture/login times. Install, model-wait, orchestration and retrieval measurements are labeled unavailable when absent. Native tool elapsed time includes that tool's work and is reported separately from subprocess timings. Consumer diagnostics, discovery and retrieval totals use the latest cumulative snapshot per operation, including failed subprocess attempts; repeated displays do not count again.
- Classified errors, nonzero helper exit status and later recovery observations. Native `completed` does not hide an embedded exit-1 or exit-3 result.
- Native answer/tool part IDs, safe source and record IDs, original record indices, UTF-16 span boundaries, speakers and timestamps. Transcript and answer prose stay in their original local evidence.
- Saved, returned and client-delivered evidence coverage, relevant operation directories, unresolved answer-quality questions and a precise next action. Returning the final chunk does not by itself establish complete model delivery.

Check the resulting outcome account before handing it to another agent. Keep a meeting recap secondary to the session's execution and evidence. For answer review, split combined claims or cite every required span, check the named speaker against the cited passage, and distinguish a question, proposal, preference, agreement, commitment or unresolved issue. Structural references cannot establish semantic support automatically.

The exporter does not include raw messages, command bodies or tool titles, provider records, signed response headers, private keys or TUI input history. The existing OpenCode TUI-history retention limit remains; this workflow does not inspect or change it.

## Installed integration contract

`lib/session-handoff.mjs` exposes `buildSessionHandoff(options)` for safe in-memory rendering and `exportSessionHandoff(options)` for an exclusive local write. The OpenCode adapter supplies the native data; do not recreate this workflow with generated shell commands.

Required input is an explicit `sessionID`, `messages` from that session's native `session.messages` response, and an absolute `outputPath` in an existing private local directory. Every message, part, optional receipt and optional observation must be bound to that same session. The adapter creates the private destination directory. The writer returns `{ ok: true, status: "exported", sessionID, path }` or a classified failure without raw filesystem errors.

Optional inputs are `versions: { candidate, client, opencode, cli }`, `timings: { installMs, modelWaitMs, orchestrationMs, captureMs, loginMs, retrievalMs }`, `receipt: { sessionID, ...knownSigninReceipt }`, and observations carrying `sessionID`, a known stage/status, safe coverage/access fields, local operation path and span references. Unknown fields are omitted. No process runner, network client, share operation or authentication operation is available to this helper.

Acquisition receipts distinguish fresh remote acquisition from local historical pages. Local continuation does not imply current SQL/KV access or current source/body revision. Counts distinguish catalog meeting listings, transcript segments within a meeting, KV acquisition attempts/observed bytes (including standalone diagnostics only when explicitly run), evidence chunks and client-delivered chunks. The compact recap path has one selected-body acquisition and no default discarded probe. These are not total model latency or a guarantee of live model compliance.
