use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anlg_download_interface::DownloadProgress;
use tokio::fs;
use tokio_util::sync::CancellationToken;

use crate::Error;
use crate::download_task::params::DownloadTaskParams;
use crate::download_task::retry::{self, AfterFailure, RetryPolicy};
use crate::model::DownloadableModel;

pub(super) enum ChecksumError {
    SizeMismatch { actual: u64, expected: u64 },
    Mismatch { actual: u32, expected: u32 },
    Calculate(anlg_file::Error),
    Join(tokio::task::JoinError),
}

pub(super) enum FinalizeError {
    Finalize(Error),
    Join(tokio::task::JoinError),
}

/// Downloads `params.urls[0]`, falling back to the other URLs in order, into
/// `params.destination`, resuming from whatever partial file is already there.
///
/// Transient failures retry the same host with exponential backoff; each
/// attempt resumes from the partial file the last one left (the `file` crate
/// writes chunks strictly in order, so the partial file is always a valid
/// prefix). An HTTP status that retrying won't fix moves to the next host.
/// Switching hosts keeps the partial file: the hosts serve byte-identical
/// files, and the caller still verifies the checksum before installing.
pub(super) async fn download<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
    urls: &[String],
    progress_callback: impl Fn(anlg_download_interface::DownloadProgress) + Send + Sync,
) -> Result<(), anlg_file::Error> {
    download_with_retries(
        urls,
        &params.destination,
        &params.retry_policy,
        &params.cancellation_token,
        progress_callback,
    )
    .await
}

pub(super) async fn download_with_retries(
    urls: &[String],
    destination: &Path,
    policy: &RetryPolicy,
    token: &CancellationToken,
    progress_callback: impl Fn(DownloadProgress) + Send + Sync,
) -> Result<(), anlg_file::Error> {
    // Retries resume, so only the first `Started` is forwarded: a later one
    // would reset the reported percentage to 0 mid-download.
    let started = AtomicBool::new(false);
    let forward = |progress: DownloadProgress| {
        if matches!(progress, DownloadProgress::Started) && started.swap(true, Ordering::Relaxed) {
            return;
        }
        progress_callback(progress);
    };

    let mut last_error = None;
    let mut total_attempts = 0u32;

    'hosts: for (host_index, url) in urls.iter().enumerate() {
        let mut failures = 0u32;
        loop {
            total_attempts += 1;
            let size_before = partial_size(destination).await;

            let error = match attempt(url, destination, policy.stall_timeout, token, &forward).await
            {
                Ok(()) => return Ok(()),
                Err(error) => error,
            };

            let next = retry::classify(&error);
            if next == AfterFailure::Stop {
                return Err(error);
            }

            let size_after = partial_size(destination).await;
            if size_after >= size_before.saturating_add(policy.min_progress_bytes) {
                failures = 0;
            }
            failures += 1;

            tracing::warn!(
                error = %error,
                host_index,
                failures,
                total_attempts,
                partial_bytes = size_after,
                "model_download_attempt_failed"
            );
            last_error = Some(error);

            if total_attempts >= policy.max_total_attempts {
                break 'hosts;
            }
            if next == AfterFailure::NextHost || failures >= policy.max_attempts_per_host {
                continue 'hosts;
            }

            tokio::select! {
                _ = token.cancelled() => return Err(anlg_file::Error::Cancelled),
                _ = tokio::time::sleep(policy.backoff(failures)) => {}
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anlg_file::Error::OtherError("No download URL".to_string())))
}

/// One pass of the `file` crate's (resuming) parallel download, abandoned
/// when nothing arrives for `stall_timeout`. Dropping it mid-way is safe: the
/// crate writes synchronously and in order, so the file is a valid prefix.
async fn attempt(
    url: &str,
    destination: &Path,
    stall_timeout: Duration,
    token: &CancellationToken,
    progress_callback: &(impl Fn(DownloadProgress) + Send + Sync),
) -> Result<(), anlg_file::Error> {
    let start = Instant::now();
    let last_activity_ms = AtomicU64::new(0);
    let on_progress = |progress: DownloadProgress| {
        last_activity_ms.store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
        progress_callback(progress);
    };

    let download = anlg_file::download_file_parallel_cancellable(
        url,
        destination,
        on_progress,
        Some(token.clone()),
    );
    tokio::pin!(download);

    loop {
        let idle_deadline = |last_ms: u64| start + Duration::from_millis(last_ms) + stall_timeout;
        let deadline = idle_deadline(last_activity_ms.load(Ordering::Relaxed));
        tokio::select! {
            result = &mut download => return result,
            _ = token.cancelled() => return Err(anlg_file::Error::Cancelled),
            _ = tokio::time::sleep_until(deadline.into()) => {
                if Instant::now() >= idle_deadline(last_activity_ms.load(Ordering::Relaxed)) {
                    return Err(anlg_file::Error::OtherError(format!(
                        "Download stalled: no data received for {} s",
                        stall_timeout.as_secs()
                    )));
                }
            }
        }
    }
}

async fn partial_size(path: &Path) -> u64 {
    fs::metadata(path).await.map(|m| m.len()).unwrap_or(0)
}

/// The size check (when the model declares one), then the CRC32 check.
pub(super) async fn verify<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
) -> Result<(), ChecksumError> {
    if let Some(expected) = params.model.download_size() {
        let actual = fs::metadata(&params.destination)
            .await
            .map_err(|e| ChecksumError::Calculate(e.into()))?
            .len();
        if actual != expected {
            return Err(ChecksumError::SizeMismatch { actual, expected });
        }
    }
    match params.model.download_checksum() {
        Some(expected_checksum) => verify_checksum(params, expected_checksum).await,
        None => Ok(()),
    }
}

async fn verify_checksum<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
    expected_checksum: u32,
) -> Result<(), ChecksumError> {
    let destination_for_checksum = params.destination.clone();
    let checksum_result = tokio::task::spawn_blocking(move || {
        anlg_file::calculate_file_checksum(destination_for_checksum)
    })
    .await;

    match checksum_result {
        Ok(Ok(actual_checksum)) => {
            if actual_checksum == expected_checksum {
                Ok(())
            } else {
                Err(ChecksumError::Mismatch {
                    actual: actual_checksum,
                    expected: expected_checksum,
                })
            }
        }
        Ok(Err(e)) => Err(ChecksumError::Calculate(e)),
        Err(e) => Err(ChecksumError::Join(e)),
    }
}

pub(super) async fn finalize<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
) -> Result<(), FinalizeError> {
    let destination_for_finalize = params.destination.clone();
    let model_for_finalize = params.model.clone();
    let models_base_for_finalize = params.models_base.clone();
    let finalize_result = tokio::task::spawn_blocking(move || {
        model_for_finalize.finalize_download(&destination_for_finalize, &models_base_for_finalize)
    })
    .await;

    match finalize_result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(FinalizeError::Finalize(e)),
        Err(e) => Err(FinalizeError::Join(e)),
    }
}

pub(super) async fn promote<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
) -> Result<(), std::io::Error> {
    match fs::rename(&params.destination, &params.final_destination).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&params.final_destination).await;
            fs::rename(&params.destination, &params.final_destination).await
        }
        Err(e) => Err(e),
    }
}
