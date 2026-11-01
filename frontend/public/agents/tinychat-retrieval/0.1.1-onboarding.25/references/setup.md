# TinyChat sign-in and recovery

TinyChat uses the owner's TinyCloud onboarding sign-in: the `TC_PROFILE` profile, else `default`, on `https://tee.node.tinycloud.xyz`. It never creates its own profile. Set PACK to this installed skill directory, resolved from terminal HOME, on a preceding line of the same shell invocation. If the app prompt supplies a configuration (schemaVersion 1, one host, `applications` and optional expectedOwner), write it to a temporary JSON file and add `--config "$CONFIG"` the first time. In OpenCode, `tinychat_setup` with `configPath` does the same. Available TinyChat tools identify the installed adapter; broad directory globs are unnecessary.

```sh
node "$PACK/scripts/setup.mjs" prepare
```

It reports one status:

- `ready`: continue with the owner's request.
- `onboarding-required`: TinyCloud isn't set up here yet, or the sign-in expired. Follow https://agents.tinycloud.xyz/onboarding, then run `prepare` again.
- `access-required`: the profile can't read TinyChat yet. Ask once, below.

## Ask once for TinyChat access

```sh
node "$PACK/scripts/setup.mjs" authorize
```

It prints `approvalUrl` and `message`. Send the owner both in one message: “Open this link and approve TinyChat access, then send me the short code OpenKey shows (like ABCD-EFGH).” When they reply with the code, pass it exactly as sent:

```sh
node "$PACK/scripts/setup.mjs" login --code '<the code>'
```

A long JSON code can go on stdin instead: `printf '%s\n' '<the code>' | node "$PACK/scripts/setup.mjs" login`. In OpenCode, call `tinychat_authorize` with no arguments for the link, then with `code` set to the owner's code.

Under the hood this runs the official CLI's `auth request --cap 'tinycloud.sql:applications:xyz.tinycloud.tinychat/connectors:read' --cap 'tinycloud.kv:applications:xyz.tinycloud.tinychat/connectors/:get' --grant --paste --expiry 30d`, with the code on stdin. The official CLI checks the code against this profile's key. TinyChat only reads the owner's meeting list and transcripts.

The owner can open the link on any device, their phone included, so this works the same on a remote machine. Each code works once and expires after 5 minutes. If the code is refused, run `authorize` again and send the new link.

`OWNER_MISMATCH` means the approval or profile belongs to a different account than the app expects: approve with the account the owner uses for TinyChat, or run onboarding with that account. Other error codes keep their CLI meaning; report them rather than retrying with other options.

## Optional OpenCode adapter

On local macOS OpenCode 1.18.31, the adapter adds the `tinychat_*` tools. To load it in the current conversation, run `node "$HOME/.agents/skills/tinychat-retrieval/scripts/install-opencode.mjs" --activate` as the last, separate native bash tool call. Do not combine it with other commands or run it in the background or parallel with another tool. Automatic activation supports local macOS with Node >=22.20 and stock OpenCode 1.18.31 launched directly as `opencode` or `opencode /absolute/project/path`. Use one active chat and no background agents; `--prompt`, `--mini`, `serve`, `run`, `attach`, wrappers and remote clients are unsupported. The activation tool interruption is expected while the integration loads; the same conversation resumes automatically, without a client restart or extra “continue.” On a classified activation error, use `setup.mjs` and `consume.mjs` as in any other agent.

The installer creates a `.js` loader in the client configuration's `plugins` directory. The loaded plugin raises the client's in-memory tool-output limits to at least 96 KiB and 2,000 lines for the session, preserving larger values and leaving configuration files unchanged.

For installation from a human-operated terminal before starting OpenCode, `node "$HOME/.agents/skills/tinychat-retrieval/scripts/install-opencode.mjs"` without `--activate` only writes the loader; it does not load it into a running client. Its `restartRequired: true` receipt means an already-running client must be restarted to load that plain installation. A client started after installation loads it normally. This plain installer is separate from the automatic first-install path above.

## Retrieval runtime recovery

The installed consumer launches `node` from the client PATH; the OpenCode executable itself is not a Node interpreter. `NODE_UNAVAILABLE` means Node.js 22.20 or later must be restored on that PATH. Keep the selected TinyCloud profile and valid authorization, then retry the same saved operation. Repeated sign-in cannot repair a missing JavaScript runtime.

## Verified context and return visits

If the user requested setup or login only, stop at the ready result. Retrieve meetings only when requested. For a last-meeting request, call `tinychat_meetings` action `latest` with a short operation name. It selects, tests actual SQL/body access and returns evidence immediately. Follow a non-null `nextAction` with its explicit chunk number; answer directly when it is null. Cite the delivered span refs and check their meaning and speakers. General browsing uses `discover` and an explicit `read` meeting selection. For specialized standalone search, get `retrievalArgs` from `tinychat_setup` in OpenCode, or from `node "$PACK/scripts/setup.mjs" context` in other clients, and use them programmatically. The owner is the verified primary DID, never the session `did:key`. Empty SQL metadata cannot prove body access. See [meetings.md](meetings.md) for the coverage, historical-evidence and citation contract.
