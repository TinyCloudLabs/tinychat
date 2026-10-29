# Fireflies agent-sync runner setup

This runner uses a dedicated CLI profile signed in to the same TinyCloud account that owns the Fireflies connector. It is an `owner-openkey` profile with its own session key, not a `delegate-session` profile. The signed pairing grant is addressed to this profile's session DID and is loaded at runtime; do not use `tc auth import` for the pairing grant.

## Provision a dedicated profile

Run the one-time setup under the runner's service account. Use a private `TC_HOME`; the profile key and session contain signing material and bearer credentials.

```sh
export TC_HOME="$HOME/.tinycloud-connector-sync"
umask 077

# The profile creates a separate session key. Sign in with the account that owns
# the Fireflies connector; do not create or copy an owner's wallet private key.
tc profile create connector-sync \
  --host https://node.tinycloud.xyz \
  --posture owner-openkey \
  --operator agent

tc --profile connector-sync auth login --method openkey
```

The sign-in is interactive and must use the same owner account used to connect Fireflies. Confirm the profile before pairing:

```sh
tc --profile connector-sync auth status --json
```

`ownerDid` must be the Fireflies owner's `did:pkh`; `spaceId` must be that owner's `applications` space. Record `sessionDid` from the status output. The pairing UI must grant to this exact DID (the session's `verificationMethod`), not to the profile's stable DID or an unrelated runner key.

## Pair and install the named-key grant

In tinycloud.chat, signed in to the same owner account, open **Meeting sources → Fireflies → Manage → Pair local agent-sync** and enter the runner profile's `sessionDid`. Store the downloaded `fireflies-named-grant.json` at:

```text
$HOME/.local/state/connector-sync/fireflies-named-grant.json
```

Protect the file as owner-only. Pairing creates a 29-day child grant with only the Fireflies envelope KV get and Fireflies named-key decrypt. The runner verifies the signed grant, installs it with `useRuntimeDelegation`, reads the envelope, and decrypts the named key. It does not import the grant into CLI auth state. If the grant file is present but invalid or expired, the runner fails closed; it does not fall back to the legacy profile.

Run a one-shot sync with:

```sh
TC_HOME="$HOME/.tinycloud-connector-sync" \
  bun scripts/agent-sync/fireflies.ts --now \
  --owner "$OWNER_DID" \
  --tc "$(command -v tc)" \
  --profile connector-sync \
  --state-dir "$HOME/.local/state/connector-sync"
```

Omit `--now` for the normal scheduler mode. The `connector-sync-key` profile is only used by the legacy fallback when no grant artifact exists; do not provision it for named-grant-only operation.

## Security boundary

Keep `profile.json`, `session.json`, and `key.json` private to the runner account; do not commit or log their contents. The 29-day child grant is narrow, but the runner's owner-openkey session retains its own sign-in permissions. Current sign-in still requests default-key decrypt and legacy vault rows; this guide does not make that base session least-privilege. The TC-1977 sign-in-scope follow-up must remove that broader grant before this profile is treated as least-privilege. A true `delegate-session` profile is not a substitute until its grant/import flow is verified separately.
