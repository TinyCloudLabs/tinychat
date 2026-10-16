# Exo development logs

Development builds write one JSON object per line. Each entry has `at`,
`kind`, and `source_id` (null for session, request, and native bridge events).
Note events use the recording ID as `source_id`. Request paths omit query
strings and variable path segments. Bridge events contain plugin and method
names, duration, and outcome; they never contain arguments or results.
Capacitor's own `loggingBehavior` stays `none` because it cannot redact
secure storage and OpenKey payloads. Release builds do not enable these sinks.

## Desktop (Tauri debug/dev)

```sh
tail -F "$HOME/Library/Logs/xyz.tinycloud.exo/exo-dev.log"
# Filter one recording:
tail -F "$HOME/Library/Logs/xyz.tinycloud.exo/exo-dev.log" | jq -c 'select(.source_id == "RECORDING_ID")'
```

Native recorder, Whisper, and uploader tracing also goes to Tauri's stdout
and this file at info level. The file rotates at about 5 MiB to
`exo-dev.log.1`.

## iOS device build (`xyz.tinycloud.exo.dev`)

The debug app writes to `Library/Logs/exo-dev.log` in its app data container
and mirrors each line to unified logging with subsystem
`xyz.tinycloud.exo.dev`, category `app`. The file can be pulled over Wi-Fi
from a paired device:

```sh
xcrun devicectl list devices
xcrun devicectl device copy from --device DEVICE_ID \
  --domain-type appDataContainer --domain-identifier xyz.tinycloud.exo.dev \
  --source Library/Logs/exo-dev.log --destination ./exo-ios-dev.log
tail -f ./exo-ios-dev.log
```

Run the copy command again to get new lines; the app container file is not a
live stream on the Mac. Its rotated predecessor is
`Library/Logs/exo-dev.log.1`.

## Android debug build

Android Debug keeps the `xyz.tinycloud.exo` application ID. Logging is enabled
by `BuildConfig.DEBUG`.

```sh
adb devices
adb -s DEVICE_ID logcat -v raw ExoDev:I '*:S'
# For a Wi-Fi debugging session first: adb connect HOST:PORT
```

## Vite web development

Run `bun run --cwd frontend dev` and read the browser DevTools Console.
Every app log line is plain JSON. Production Vite builds do not emit it.

## Backend HTTP correlation (TC-959)

Canonical source: `TinyCloudLabs/tinycloud-dev` commit
`76bd10752a52f179ac2a49214f488236d02f8192`,
`ops/logging/request-id.md`. The exact `request-id-vectors.json` corpus is
vendored at `backend/src/__tests__/fixtures/request-id-vectors.json`
(SHA256 `d995cd9065a9e1c51bc4d3ed041c3bf2a0363e9a04a90f1d07914437d8dd9a80`).
Tests exercise all raw-value cases, including padding/newline rejection,
and real HTTP field occurrences, including identical duplicate header lines.

Every HTTP response, including authentication, CSRF, parser and routing failures,
has `X-Request-Id`. Accept only the canonical 36-character RFC 9562 UUID format:
versions 1–8 and variant `10xx` (the fourth group starts with `8`, `9`, `a` or
`b`). Input is case-insensitive and accepted IDs are lowercased. Nil, max,
nonhex, wrong length/version/variant, empty, duplicate and comma-folded values
are rejected. Absent or rejected input gets a fresh UUID v4.
The typed request event's boolean `request_id_replaced` is `true` only when an
incoming header was rejected; it is `false` for accepted or absent input.
Rejected bytes are never logged. The header is correlation metadata, not an
authentication or tenant identity.

The same request ID is forwarded only on request-scoped first-party ptx-dev
and ptx-batch calls. `TRANSCRIPTION_API_URL` and
`PRIVATE_CLOUD_TRANSCRIPTION_API_URL` select destinations; **neither implicitly
classifies a destination as first-party**. Separately set the nonsecret
`REQUEST_ID_FIRST_PARTY_ORIGINS` to a comma-separated list of bare HTTP(S)
origins owned by the operator. Scheme, canonical host and effective port must
match exactly. Empty means no request-ID forwarding; invalid entries refuse
startup without echoing the configuration. Paths, hostname suffixes and
webhook status do not confer trust. Do not classify Google, Vexa, Tinfoil or
any other third party.

Both PTX clients refuse to follow redirects (including 302 and 307), so neither
the request ID nor credentials reach a redirect destination. Transport retries
to a classified origin retain the same ID. No global fetch hook forwards IDs to
third-party requests. Calls started outside an HTTP request do not inherit an
unrelated caller's ID. There is no backend OpenKey HTTP client: OpenKey signing
runs in the web/native clients and the backend verifies the session locally.

Private transcription's `X-Correlation-Id` remains an **independent** contract:
its existing UUID acceptance/minting, response header, `error.correlation_id`
and forwarding to ptx-batch are unchanged. When both headers are valid and
different, neither overwrites the other. A legacy correlation-only client still
gets its original correlation ID and a separately minted request ID.
Authentication/CSRF rejection before that router still has no correlation ID.
Both headers are exposed by CORS.
The stricter request-ID predicate does not narrow legacy correlation-ID syntax.

One JSON `tinychat_request` event is emitted when the response finishes:

```json
{"event":"tinychat_request","request_id":"12345678-abcd-4abc-8abc-123456789abc","request_id_replaced":false,"method":"GET","route":"/transcriptions/:id","status":200,"duration_ms":2.5,"correlation_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}
```

`method` is a known HTTP method or `OTHER`; `status` and `duration_ms` are
numeric. `route` is Express's registered **terminal route template**, without
the router mount prefix. Early middleware failures and unmatched requests use
`unmatched`. Never use `baseUrl`, `originalUrl`, path parameters or query
strings: even a router mount can contain credentials. `correlation_id` is
optional and admitted only as a UUID from the response header.

While an HTTP request context is active, console and dependency stdout/stderr
payloads are replaced with fixed `tinychat_request_diagnostic` events containing
only `request_id` and `level` (`info` or `error`). Arbitrary JSON is not trusted
as a typed event. The terminal error handler also drops error names, messages
and properties. No account, wallet, tenant, capability, meeting ID, transcript
or keyed identity field is added. Existing `LOG_HASH_SALT`/keyed-hash patterns
remain unchanged. Startup/background logging and native writes that bypass
JavaScript console/stream APIs are outside this request-scoped boundary; this
change is not a backend-wide log shipping/redaction cutover.
Outside request scope, stream writes preserve the original receiver, argument
list and callback overloads, including `write(chunk, undefined, callback)`.

Regression checks (synthetic localhost HTTP and subprocess output only):

```sh
bun test backend/src/__tests__/request-id.test.ts backend/src/__tests__/index-wiring.test.ts backend/src/__tests__/request-log-boundary.test.ts
```

