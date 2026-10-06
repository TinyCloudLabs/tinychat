# Vendored `file` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/file` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. Its
`download_file_parallel_cancellable` does the HTTP work for model downloads
(through the vendored `model-downloader`).

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

At the pinned rev one failed ranged chunk failed the whole download, and the
shared HTTP client had no timeouts, so a silent connection hung a download
forever (TC-771). Retrying whole attempts (in `model-downloader`) is not
enough on its own: Cloudflare in front of `models.anarlog.so`, the fallback
host, answers the first range request after a HEAD on a connection with
`200 OK` and the whole file. Every attempt starts with a HEAD, so for Whisper
Large Turbo every attempt failed the same way. Asking for that chunk again
gets a `206`.

## Local change

`src/lib.rs`:

- `download_file_parallel_cancellable`: each chunk's request moved into
  `download_range_into`. A transient chunk failure (network or body error,
  read timeout, a `200` answering a range request, 408, 429, 5xx, or a
  response shorter than its range) retries that chunk up to 3 times (0.5 s,
  1 s, 2 s backoff), asking only for the bytes it does not have yet. Other
  statuses (403, 404, ...) still fail the download with the same message as
  upstream, so `model-downloader` moves to the next host.
- `get_client`: 30 s connect timeout and 30 s read timeout (per read, reset by
  each received piece of data).

`src/tests.rs`: two tests (a chunk answered with `200` then `503` is
retried; the transient-error classification).

`Cargo.toml` `workspace = true` entries were rewritten: anarlog crates as git
dependencies on the same rev (`download-interface`; dev: `s3`), external
crates at the versions declared in the pinned workspace root (`base64 0.22.1`,
`thiserror 2`, `futures-util 0.3.31`, `reqwest 0.13`, `tokio 1` (plus the
`time` feature), `tracing 0.1`; dev: `dirs 6.0.0`, `tempfile 3`,
`testcontainers-modules 0.12.1`, `wiremock 0.6`).

Removal trigger: upstream retries failed chunks and sets client timeouts (or
the anarlog pin moves to a rev that does), together with the vendored
`model-downloader`.

Applied via `[patch."https://github.com/fastrepl/anarlog"]` in
`src-tauri/Cargo.toml`; the vendored `model-downloader` and `local-model`
depend on it by path.
