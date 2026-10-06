# Vendored `model-downloader` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/model-downloader` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. It runs the
model downloads for `tauri-plugin-local-stt` (Whisper models), through the
`file` crate's `download_file_parallel_cancellable` (vendored alongside, see
`../anarlog-file/PROVENANCE.md`).

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

At the pinned rev a model download (TC-771):

- did not retry: any failed ranged chunk failed the whole download;
- deleted its partial file on every failure, and wrote each attempt to a new
  `.part-<generation>` file, so a Large Turbo (~874 MB) download that failed at
  90% restarted from 0;
- had one host and no fallback (TC-769 was a 403 from that host);
- had no stall bound: a connection that went silent hung the download
  forever;
- cancelled and restarted a running download when asked to download again.

## Local change

- `src/download_task/steps.rs` `download` / `download_with_retries`: runs the
  `file` crate's (already resuming) parallel download in attempts. Each attempt
  is abandoned after `stall_timeout` (60 s) with no data. (Within an attempt
  the vendored `file` crate already retries a failed chunk.) Transient
  failures (network errors, stalls, 5xx, 408, 429, a `200` answering a range
  request) retry the same host with exponential
  backoff (1 s doubling, capped at 30 s), up to 5 consecutive attempts that
  each add less than 1 MiB; an attempt that adds at least 1 MiB resets that
  count, and 50 attempts is the hard cap. Any other HTTP status (403, 404,
  ...), or a range response longer than requested, moves to the next host at
  once. A disk error or
  cancellation stops. Every attempt, on every host, resumes from the partial
  file: the `file` crate writes chunks strictly in order, so it is always a
  prefix of the model. Only the first `Started` progress event is forwarded,
  so a retry does not reset the reported percentage to 0.
- `src/download_task/retry.rs` (new): `RetryPolicy` (public, with defaults,
  set through `ModelDownloadManager::with_retry_policy`) and the error
  classification. The pinned `file` crate reports unexpected HTTP statuses
  only as text ("... (status 403 Forbidden): <url>"), so the status is parsed
  from the message; unit tests cover all three message shapes.
- `src/model.rs`: `DownloadableModel::download_fallback_urls()` (default
  empty): hosts serving byte-identical copies, tried in order after
  `download_url()`; `DownloadableModel::download_size()` (default `None`):
  the exact size, checked before the checksum.
- `src/download_task/{mod,steps}.rs` verification: the finished file must
  match `download_size()` (when declared), then `download_checksum()`, before
  finalize/promote. If either fails and fallback hosts remain, the partial
  file is deleted and the model is downloaded once more from scratch from the
  fallback hosts only (progress restarts at 0%); a second failure deletes the
  partial file and fails.
- `src/manager.rs`: fallback URLs are used only when the model has a checksum
  (a download resumed across hosts must be verified). The partial file is
  `<file>.part`, stable across attempts (`src/download_paths.rs`). Calling
  `download` while a download of the same model is running joins it (returns
  `Ok`, its events keep coming) instead of cancelling and restarting it; an
  entry whose task already ended without deregistering (a panic) does not
  count as running and is dropped (`DownloadsRegistry::is_running`, also used
  by `is_downloading`). `download` and `cancel_download` are serialized by a
  manager-wide lock, so a download requested during a cancel starts only after
  the cancel has deleted the shared partial file.
- `src/download_task/{mod,failure}.rs`: a failed download keeps its partial
  file when the model has a checksum; without one it is deleted as upstream
  did. A checksum mismatch, a finalize error or a failed move still deletes
  it, and the size (where declared) + CRC32 check runs before any install. The registry
  entry is removed before the `Completed` / `Failed` event is emitted, so a
  download requested in response starts a new task rather than joining the
  finished one. `cancel_download` is unchanged: it still deletes the partial.
- Tests: `tests/resilience.rs` (new) runs a local HTTP/1.1 server that cuts
  responses mid-body, stalls, answers a range request with the whole file, or
  answers 403/404/5xx. It covers a cut chunk resuming where it stopped, the
  Cloudflare `200`, a failed attempt retried with backoff, a stall, a failed
  download keeping its partial file and the next download resuming it, a 403
  falling back without retrying the primary, resuming across hosts, a corrupt
  partial failing the checksum and being deleted, no fallback or kept partial
  without a checksum, joining a running download, a panicked task not
  blocking later downloads, a download requested during a cancel waiting for
  it, a size mismatch failing and deleting the partial, a corrupt primary
  download redone from scratch from the fallback, and a second corrupt
  download failing. `tests/manager.rs` (upstream) now looks for `.part`
  files and uses a short retry policy for its failure test.

`Cargo.toml` `workspace = true` entries were rewritten: `file` as a path
dependency on the vendored copy, `download-interface` as a git dependency on
the same rev, external crates at
the versions declared in the pinned workspace root (`serde 1`,
`specta 2.0.0-rc.22`, `thiserror 2`, `tokio 1` (plus the `time` feature),
`tokio-util 0.7.15`, `tracing 0.1`; dev: `tempfile 3`, `wiremock 0.6`, `tokio`
`net` + `io-util` for the test server).

Removal trigger: upstream retries, resumes after a failure and supports a
fallback host (or the anarlog pin moves to a rev that does); remove the
vendored `file` and `local-model` with it.

Applied via `[patch."https://github.com/fastrepl/anarlog"]` in
`src-tauri/Cargo.toml`.
