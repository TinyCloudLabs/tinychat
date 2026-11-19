# TinyChat sign-in and recovery

The normal OpenCode 1.18.31 flow is `tinychat_setup` → `tinychat_authorize` → browser approval → one chat paste → verified receipt. The copied app prompt supplies schemaVersion 1, one host, `applications` and optional expectedOwner. Call `tinychat_setup` with the app JSON’s absolute `configPath` initially; omit it on return visits to reuse saved selection. For non-OpenCode clients using the standalone helper, set PACK and CONFIG on preceding lines in the same shell invocation; resolve PACK using terminal HOME and use `prepare --config "$CONFIG"` initially, then `prepare`. Available TinyChat tools identify the installed adapter; broad directory globs are unnecessary.

After installing the CLI and both skills, run `node "$HOME/.agents/skills/tinychat-retrieval/scripts/install-opencode.mjs" --activate` as the last, separate native bash tool call. Do not combine it with other commands or run it in the background or parallel with another tool. Automatic activation supports local macOS with Node >=22.20 and stock OpenCode 1.18.31 launched directly as `opencode` or `opencode /absolute/project/path`. Use one active chat and no background agents; `--prompt`, `--mini`, `serve`, `run`, `attach`, wrappers and remote clients are unsupported. The activation tool interruption is expected while the integration loads; the same conversation resumes automatically, without a client restart or extra “continue.” Stop and report a classified activation error rather than attempting another authorization transport.

The installer creates a `.js` loader in the client configuration's `plugins` directory. The loaded plugin raises the client's in-memory tool-output limits to at least 96 KiB and 2,000 lines for the session, preserving larger values and leaving configuration files unchanged. Continue only when `tinychat_setup` and `tinychat_authorize` are actually available as tools. Installed files alone do not establish loaded capture. If tools are missing, do not open authorization or ask for a paste. Never use standalone `setup.mjs authorize`, `setup.mjs login` or `tc auth login` as an OpenCode fallback.

For installation from a human-operated terminal before starting OpenCode, `node "$HOME/.agents/skills/tinychat-retrieval/scripts/install-opencode.mjs"` without `--activate` only writes the loader; it does not load it into a running client. Its `restartRequired: true` receipt means an already-running client must be restarted to load that plain installation. A client started after installation loads it normally. This plain installer is separate from the automatic first-install path above.

## Local approval and capture

Call `tinychat_authorize` with no arguments. On `delivery.status: launch-requested`, say **“Complete sign-in in the browser, then paste the code here.”** The browser opener received the exact URL; this is awaiting approval, not proof of a visible page or login. No shell process waits for consent. Repeating the tool while approval is pending returns the same pending operation without another browser visit.

The `chat.message` hook captures the single original, non-synthetic text part from that conversation and passes it directly into `setup.login` and official CLI stdin. It redacts the part in place before native conversation persistence and the model loop. It never uses a code supplied as a model tool argument. Supported inputs are complete JSON (including multiline) and base64 JSON; only the existing helper's encoding/whitespace normalization applies. The TUI normalizes line endings and whitespace first and retains original paste text in its local input history. The plugin does not rewrite that client history.

The pending operation binds conversation, approval ID, selected profile, host, session key DID and exact CLI login arguments (including manifest and expected owner). It rechecks bindings immediately before CLI verification. An expected owner comes from app metadata or saved selection; otherwise the browser selects the identity, without independent matching to TinyChat. Do not ask for a manual DID or change the manifest. The CLI still verifies signature, key, owner, scope and expiry.

`tinychat_signin_status` returns the last receipt or pending status. Missing responses remain pending. Multiple original text parts or accompanying file parts fail with `AMBIGUOUS_AUTH_RESPONSE`; they are not concatenated. Malformed or truncated response text fails with `INVALID_AUTH_RESPONSE`. Duplicate message IDs and successful repeated payloads return `DUPLICATE_AUTH_RESPONSE` without re-verification. Overlapping captures return `AUTH_CAPTURE_IN_PROGRESS`. A response from another conversation has `NO_PENDING_APPROVAL`, and the same profile cannot acquire another pending approval in another conversation in this plugin instance. Profile/key drift fails with `APPROVAL_CONTEXT_CHANGED`. No historical or latest credential is chosen.

Errors contain only a safe code and status, never the response. Proof, owner, scope, broadened-grant and expiry errors stay distinct. `AUTH_EXPIRED` releases the pending operation so a new authorization can be requested; other rejections leave it pending for correction. A parse failure does not imply expired consent. Restarting the client discards pending operations; finish in the same running conversation. Explicit account changes should start after the current operation has finished.

## Browser recovery and other clients

A noninteractive local shell is not a remote environment. If launch fails or the user reports no page, open `delivery.artifactPath` locally. The private mode-0600 HTML holds the exact URL. Do not read out, decode or reconstruct it. Keep it until completion or cancellation; the plugin removes only its own artifact and empty directory after successful login. Cleanup failure does not change the verification result. Browser-launch failure also arms capture, so a response obtained via that artifact proceeds directly to verification.

Non-OpenCode clients use the standalone helper only with an existing client-owned private response-file transport. These commands do not enable chat capture and must not be used as an OpenCode fallback:

```sh
node "$PACK/scripts/setup.mjs" authorize
node "$PACK/scripts/setup.mjs" authorize --delivery file
node "$PACK/scripts/setup.mjs" login --code-file ABS_PRIVATE_CODE_FILE
```

For a non-OpenCode client on a known remote host, explicit file delivery skips the opener. Transfer the complete HTML through a trusted client file-transfer channel and open it locally. Report an unavailable transfer route only for that actual remote case. This standalone helper does not bind OpenCode chat capture. These non-OpenCode clients may pass an already-existing client-owned private response file to `login --code-file`; they must not have the model regenerate opaque code into that file. This release's automatic chat-paste experience is implemented for local OpenCode.

`--code-file` belongs to the setup helper, not `tc auth login`. It accepts an absolute private file outside the project and sends the supported normalized payload through CLI stdin. Preserve its nonzero exit across any cleanup; never remove a user-owned file. Do not scrape shell history or read the clipboard. The interactive `loginCommand` is for a human-operated terminal, not a waiting process in a shell tool.

## Retrieval runtime recovery

The installed consumer launches `node` from the client PATH; the OpenCode executable itself is not a Node interpreter. `NODE_UNAVAILABLE` means Node.js 20 or later must be restored on that PATH. Keep the selected TinyCloud profile and valid authorization, then retry the same saved operation. Repeated sign-in cannot repair a missing JavaScript runtime.

## Verified context and return visits

If the user requested setup or login only, stop at the ready receipt. Retrieve meetings only when requested. For a last-meeting request, call `tinychat_meetings` action `latest` with a short operation name. It selects, tests actual SQL/body access and returns evidence immediately. Follow a non-null `nextAction` with its explicit chunk number; answer directly when it is null. Cite the delivered span refs and check their meaning and speakers. General browsing uses `discover` and an explicit `read` meeting selection. For specialized standalone search, get `retrievalArgs` from `tinychat_setup` in OpenCode, or from `node "$PACK/scripts/setup.mjs" context` in other clients, and use them programmatically. The owner is the verified primary DID, never the session `did:key`. Empty SQL metadata cannot prove body access. See [meetings.md](meetings.md) for the coverage, historical-evidence and citation contract.
