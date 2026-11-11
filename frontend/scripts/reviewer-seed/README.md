# Reviewer seed

Writes fixed demo data into one fresh TinyCloud Home applications space, for the App Store
reviewer account (TC-2775). It uses TinyCloud Home's own write paths and reads the result back
through Home's own readers. It takes no owner key: the space owner grants this run's in-memory
session key a short delegation.

## Command

From the repository root, after `bun install`:

```sh
bun frontend/scripts/reviewer-seed/cli.ts \
  --space  tinycloud:pkh:eip155:1:0xREVIEWER:applications \
  --owner  did:pkh:eip155:1:0xREVIEWER \
  --allow-owner did:pkh:eip155:1:0xREVIEWER \
  --request-out ./reviewer-seed-request.json \
  --dry-run                                   # or: --confirm tinycloud:pkh:eip155:1:0xREVIEWER:applications
```

1. The CLI makes a session key in memory for this run and writes a capability request
   (`tinycloud.auth.request`) for it to `--request-out`, which must not exist yet. It prints the
   session DID, which is public.
2. The owner grants that request, for example
   `tinycloud --profile <reviewer owner profile> auth grant ./reviewer-seed-request.json > grant.json`.
   The owner's session must already cover the requested capabilities.
3. Paste the grant JSON into the waiting CLI and end with Ctrl-D, or pipe it in. The CLI accepts the
   `tinycloud.auth.delegation` artifact that `tinycloud auth grant` prints, or a bare portable delegation.
   Its authorization must be a compact UCAN (what a session-signed grant is); anything else is refused.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `--space` | yes | The exact applications space id to seed. |
| `--owner` | yes | The space owner's `did:pkh`. |
| `--allow-owner` | yes, repeatable | The operator's allowlist. Pass the reviewer DID only. Never read from the environment. It guards against a mistyped `--owner`; the owner's grant is what authorizes the run. |
| `--request-out` | yes | A new file for the capability request. An existing file is not overwritten (usage error). Not secret. |
| `--dry-run` / `--confirm <space id>` | one of them | A dry run writes nothing. Writing needs `--confirm` set to the same space id as `--space`. |
| `--host` | no | Node origin, `https://` with no path. Default `https://tee.node.tinycloud.xyz`. |
| grant JSON on stdin | yes | The owner's delegation to this run's session key. |

The CLI never reads or prints a private key and never prints or stores the session key or the grant.
It has no key file or key environment variable. The session key exists only in the process and goes
away when it exits.

## Requested capabilities

All entries are in the owner's `applications` space. `requestedExpiry` is `1h`.

Writing (`--confirm`):

| Service | Path | Scope | Actions |
| --- | --- | --- | --- |
| `tinycloud.sql` | `xyz.tinycloud.tinychat/threads` | whole database | read, write, schema |
| `tinycloud.sql` | `xyz.tinycloud.tinychat/home_feed` | whole database | read, write, schema |
| `tinycloud.sql` | `xyz.tinycloud.tinychat/feed/feed_output_home_tour` | whole database | read, write, schema |
| `tinycloud.sql` | `xyz.tinycloud.tinychat/feed/feed_responses_home_tour` | whole database | read, write, schema |
| `tinycloud.sql` | `xyz.tinycloud.tinychat/connectors` | whole database | read, write, schema |
| `tinycloud.kv` | `xyz.tinycloud.tinychat/connectors/exo-voice-note/transcript/tinychat-reviewer-seed-r1-voice-note` | one exact key | get, put |
| `tinycloud.kv` | `xyz.tinycloud.tinychat/connectors/exo-voice-note/transcript-rev/tinychat-reviewer-seed-r1-voice-note/` | one prefix, scoped to the seed's voice note | get, put |

The KV prefix is needed because the transcript body's key ends in its content hash
(`…/transcript-rev/<note id>/<hash>`). It covers only that seed note's revisions.

Dry run: `tinycloud.sql` read on the five databases above.

No KV delete, no other app, no other space, no secrets, no encryption. SQL write and schema are per
database, so they would allow deleting rows in those five databases; the seed only inserts, and the
freshness check is what keeps it off a space in use.

## Checks before any write

The CLI exits 2 (usage) or 3 (refused) and writes nothing when any check below fails. The flag,
allowlist, owner/space and confirmation checks run before the capability request is written, so the
owner is never asked to grant a run that would be refused.

- neither `--dry-run` nor `--confirm` is given (usage error), or `--confirm` is not exactly `--space`
  (`CONFIRMATION_REQUIRED`);
- `--owner` is not on `--allow-owner` (`OWNER_NOT_ALLOWLISTED`);
- `--space` is not `--owner`'s applications space, or the grant does not match the target (`TARGET_MISMATCH`):
  it must be addressed to this run's session key, issued by `--owner` for `--space` on `--host`,
  unexpired and at most 24 hours long, and no wider than the request (plus
  `tinycloud.capabilities/read`, which OpenKey adds). This is checked twice before use: on the
  grant's transport fields (listed resources, flat path and actions), and on its signed UCAN
  payload, decoded in process (`aud`, `exp`, and every resource and ability in `att`). The
  signature and the delegation chain back to the owner are verified by the node, not locally;
- the space is not fresh (`NOT_FRESH`): any row in any table of the five databases above, except
  `threads.settings`. `settings` holds preferences, such as the default Feed view, that Home may
  write at sign-in. When the space has this revision's `in-progress` marker (an interrupted run),
  only rows with the seed's own ids are allowed (the thread, its four message ids, the agent, the
  four card issuances, the voice-note row and its transcript commit). The check only reads `sqlite_master` and
  `COUNT(*)`; it creates nothing;
- the space has a seed marker from another revision, or one it cannot read (`OTHER_REVISION`);
- the freshness check cannot read a database or count a table (`INSPECTION_FAILED`).

## What it writes

Every write goes through TinyCloud Home's code at this commit. The seed has no SQL schema of its own.

| Item | Home code path | Database and ids |
| --- | --- | --- |
| Seed marker | `setSetting` (`lib/threadStore.ts`) | `threads.settings`, key `xyz.tinycloud.tinychat:reviewer-seed`, written first as `in-progress` and last as `complete` |
| Feed registry tables | `createHomeFeedSource().load()` (`feed/feedStore.ts`) | `home_feed` |
| 4 Feed cards (2 need an answer) | `initializeFeedDatabases`, `publishFeedCard` (`@tinycloud/sdk-services/feed`) | `feed/feed_output_home_tour`, cards `welcome`, `first-step`, `your-space`, `weekly-summary` |
| Feed source "TinyCloud Home tour" | one `feed_agents` row, the columns Home's reader selects | `home_feed.feed_agents`, `agent_id = home-tour`, `agent_did` = the owner, provenance `{"seed":"tinychat-reviewer-seed","revision":1}` |
| 1 chat, 4 messages | `appendMessage` (`lib/threadStore.ts`), as the chat runtime saves a turn | `threads`, thread `tinychat-reviewer-seed-r1-chat` |
| 1 voice note with transcript | `ensureVoiceNoteIdentity`, `createPastedTranscriptRow`, `commitVoiceNoteTranscript` (`lib/voiceNotes/voiceNoteRows.ts`), with `pastedTranscriptCommit` from the Library's paste path | `connectors.connector_meeting` row `vn-tinychat-reviewer-seed-r1-voice-note`, `voice_note_transcript`, transcript bodies in KV |

Home does not register Feed sources itself (that is done by agent provisioning outside this repo),
so the seed writes the one `feed_agents` row directly, after the cards, so Home never lists a source
whose cards are missing.

The voice note is transcript-only: it is the note the Library's "paste a transcript" upload creates,
with the same row, commit table and KV layout as a recorded note, and no audio. A synthetic clip would
not match its transcript. The Library labels it "Pasted transcript". On the Home build, the Library
asks the reviewer for the Recording permissions the first time it opens, then lists the note.

All text is fixed, neutral content about trying TinyCloud Home (`content.ts`). Times are offsets from
`seededAt`, the run's start, which the marker records.

## Output

JSON on stdout:

```json
{ "status": "seeded", "seed": "tinychat-reviewer-seed", "revision": 1,
  "spaceId": "…", "ownerDid": "…", "seededAt": "…", "writes": [ … ],
  "readBack": { "chats": [ … ], "feedCards": [ … ], "voiceNotes": [ … ] } }
```

`status` is `planned` (dry run: `writes` is the plan, nothing written), `seeded`, `resumed` (an
interrupted run of this revision was finished) or `already-seeded` (nothing written). After a write,
`readBack` is what Home's readers return: `listThreads` and `getThread`, the Feed's
`createHomeFeedSource().load()`, and the Library's `listMeetingsRead` and `readTranscript`.

## Revisions

- Seed revision: `SEED_REVISION` in `content.ts`, now `1`. Any change to content, ids or write paths
  is a new revision. The marker records it; a space seeded at another revision is refused.
- Schema: the seed writes whatever schema TinyCloud Home's code creates at this commit (the threads
  tables, the Feed tables of `@tinycloud/sdk-services` 3.11.0, the connectors tables and
  `voice_note_transcript`). Running the seed from a later commit uses that commit's schema.

## Idempotency and reset

- Rerunning a seeded space (`complete` marker, same revision) writes nothing and reports `already-seeded`.
- An interrupted run leaves an `in-progress` marker. Rerunning finishes it with the recorded `seededAt`:
  each step skips or repeats identically (cards are content-addressed by identity, messages by id, the
  voice note row is looked up first, the transcript commit is by revision and hash). It refuses if the
  space has gained any row the seed did not write.
- Reset: the operator wipes the reviewer's applications space on the node side (the seed deletes
  nothing and is not granted KV delete), then runs the seed again. A wiped space is fresh.
- Do not run two seeds against one space at once, and keep the reviewer account signed out of Home
  while the seed runs: the freshness check and the writes are not one transaction.

## What to check (security review)

- No key input or output: `cli.ts` creates a session-only `TinyCloudNode`; there is no `privateKey`,
  key file or key environment variable, and only the session DID is printed. Errors print only messages.
- Authority is the owner's grant alone. It is locally checked and node-verified: `args.ts`
  `assertGrant` checks its transport fields and its decoded signed payload (`signedGrant`) against
  the request before use, failing closed on anything wider or not a compact UCAN; the node verifies the
  signature and the chain to the owner. The handle's owner DID comes from the grant, so `seed.ts`
  checks it against the target again.
- The allowlist and target come only from flags (`args.ts` `parseSeedArgs`); `seed.ts`
  `assertSeedTarget` checks the owner, the space and the confirmation before the request is written.
  The allowlist is a guard against a mistyped owner, not authority.
- The freshness check (`inspectSpace`) is read-only and fails closed on any read error or odd count.
- The request (`seedPermissions`) is five whole SQL databases, one exact KV key and one KV prefix scoped
  to the seed's voice note, no KV delete, one hour. A test checks that the seed and its read-back touch
  exactly the requested SQL databases and KV keys.
- KV calls are made with an empty prefix (`cli.ts` `rootKv`), so keys are the full in-space keys Home
  uses and are not re-rooted under the grant's first path.
- The only app change is `pastedTranscriptCommit`, extracted from `savePastedTranscript` without a
  behaviour change.

## Tests

`bun test scripts/reviewer-seed` from `frontend/` runs the seed's 11 tests against in-memory SQLite
and KV: refusal of a non-empty space, of a missing or wrong confirmation, of an owner off the
allowlist and of a mismatched grant (transport fields and signed payload); a dry run that writes
nothing; a no-op rerun; resuming an interrupted run, and refusing one whose space gained rows the
seed did not write; and the seeded items as Home's thread list, Feed and Library read them.
