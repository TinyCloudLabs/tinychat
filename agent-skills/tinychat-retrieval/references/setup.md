# Select the existing account

Install the published TinyCloud CLI and this versioned pack using TinyChat's public setup page. Installation, skill discovery in a new agent session, and TinyCloud consent are separate steps. No development checkout or provider plugin is required. This pack runs on macOS/Linux with Node >=20; Windows is not yet an accepted installation target.

Check versions without reading private data:

```sh
tc --version
node /path/to/tinychat-retrieval/scripts/retrieve.mjs --version
```

Setup needs CLI >=0.10.0 for a scoped first login. Existing compatible profiles can use the helper with CLI >=0.9.0. Use a fresh local profile name if you want its initial grant limited to the included read manifest. A local profile is a new device session for the existing account, not a new owner account.

```sh
tc init --name tinychat-reader --key-only --host HOST
tc --profile tinychat-reader --host HOST auth login --method openkey --manifest /path/to/tinychat-retrieval/assets/permissions.json --owner OWNER_DID --expiry 7d
```

Use the current host and primary owner DID shown by TinyChat's Use with your agent settings card for HOST and OWNER_DID. Complete browser identity selection, signing and consent as the same OpenKey identity already used in TinyChat. When callbacks are unavailable, use the CLI's `--paste` mode and return its code directly to the terminal, never to model chat. Do not create another account or reconnect existing data for this step.

Compare the owner from `tc --profile tinychat-reader --host HOST --json auth status` with TinyChat's Use with your agent settings card locally. Keep identifiers and session material out of shared reports. Pass that primary owner DID, intended host, and intended space explicitly:

```sh
node /path/to/tinychat-retrieval/scripts/retrieve.mjs diagnostics --profile tinychat-reader --host HOST --space applications --owner OWNER_DID
```

`diagnostics` proves current SQL read and, when a catalog row exists, one body read. It does not assert every row has a body or that database confinement has been independently verified. `auth caps` describes permissions; it is not proof that a read succeeded. The included manifest requests SQL read and KV get under TinyChat's connector resources, plus capability discovery. It requests no writes and excludes default/public-space grants. An already broader profile remains broader.

Grant expiration requires renewed consent. A denied operation requires inspecting its required permissions; repeated login is not a general fix for HTTP403. The helper never imports maintainer grants, copies connector data, modifies ingestion, or requests write authority.

Keep the pack's skill, helper and manifest from one release. Use the published installer to update or remove the complete pack. Do not fetch a mutable executable helper each time a question is asked.
