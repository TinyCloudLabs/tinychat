use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::download_task::failure::{PartialFile, cleanup_for_failure};
use crate::download_task::steps::{ChecksumError, FinalizeError};
use crate::download_task_progress::make_progress_callback;
use crate::model::DownloadableModel;

mod failure;
mod params;
mod retry;
mod steps;

pub(crate) use params::DownloadTaskParams;
pub use retry::RetryPolicy;

pub(crate) fn spawn_download_task<M: DownloadableModel>(
    params: DownloadTaskParams<M>,
    start_rx: oneshot::Receiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if start_rx.await.is_err() {
            // Never started, so never wrote: the partial path may belong to a
            // download that is still running.
            cleanup_for_failure(&params, PartialFile::Keep).await;
            return;
        }

        let progress_callback =
            make_progress_callback(params.runtime.clone(), params.model.clone());

        if let Err(error) = steps::download(&params, progress_callback).await {
            let reason = log_download_error(&error);
            // A verified download keeps its partial file for the next attempt
            // (or for the download that replaced this one). Without a checksum
            // a resumed file could not be verified, so it is discarded as
            // upstream did.
            let partial = if params.model.download_checksum().is_some() {
                PartialFile::Keep
            } else {
                PartialFile::Delete
            };
            fail_task(&params, reason, partial).await;
            return;
        }

        if let Some(expected_checksum) = params.model.download_checksum()
            && let Err(error) = steps::verify_checksum(&params, expected_checksum).await
        {
            let reason = log_checksum_error(&error);
            fail_task(&params, Some(reason), PartialFile::Delete).await;
            return;
        }

        if let Err(error) = steps::finalize(&params).await {
            let reason = log_finalize_error(&error);
            fail_task(&params, Some(reason), PartialFile::Delete).await;
            return;
        }

        if params.model.remove_destination_after_finalize() {
            let _ = tokio::fs::remove_file(&params.destination).await;
        } else if let Err(error) = steps::promote(&params).await {
            tracing::error!(error = %error, "model_download_promote_error");
            let reason = format!("Failed to move model file: {}", error);
            fail_task(&params, Some(reason), PartialFile::Delete).await;
            return;
        }

        // Leave the registry before announcing the outcome, so a download
        // requested in response to the event starts fresh instead of joining
        // this finished task.
        params
            .registry
            .remove_if_generation_matches(&params.key, params.generation)
            .await;
        params
            .runtime
            .emit_progress(&params.model, crate::runtime::DownloadStatus::Completed);
    })
}

async fn fail_task<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
    reason: Option<String>,
    partial: PartialFile,
) {
    // Clean up first (see the Completed path): a retry requested in response
    // to the Failed event must start a new task, not join this one.
    cleanup_for_failure(params, partial).await;
    if let Some(reason) = reason {
        params.runtime.emit_progress(
            &params.model,
            crate::runtime::DownloadStatus::Failed(reason),
        );
    }
}

fn log_download_error(error: &anlg_file::Error) -> Option<String> {
    if matches!(error, anlg_file::Error::Cancelled) {
        return None;
    }

    tracing::error!(error = %error, "model_download_error");

    let reason = match error {
        anlg_file::Error::ReqwestError(e) => {
            if e.is_timeout() {
                "Download timed out. Please check your internet connection and try again."
                    .to_string()
            } else if e.is_connect() {
                "Could not connect to the download server. Please check your internet connection."
                    .to_string()
            } else {
                format!("Network error: {}", e)
            }
        }
        anlg_file::Error::FileIOError(e) => {
            format!("File system error: {}", e)
        }
        anlg_file::Error::Cancelled => unreachable!(),
        anlg_file::Error::OtherError(msg) => msg.clone(),
    };
    Some(reason)
}

fn log_checksum_error(error: &ChecksumError) -> String {
    match error {
        ChecksumError::Mismatch { actual, expected } => {
            tracing::error!(
                actual_checksum = actual,
                expected_checksum = expected,
                "model_download_checksum_mismatch"
            );
            "Downloaded file is corrupted (checksum mismatch). Please try again.".to_string()
        }
        ChecksumError::Calculate(error) => {
            tracing::error!(error = %error, "model_download_checksum_error");
            format!("Failed to verify download: {}", error)
        }
        ChecksumError::Join(error) => {
            tracing::error!(error = %error, "model_download_checksum_join_error");
            format!("Verification interrupted: {}", error)
        }
    }
}

fn log_finalize_error(error: &FinalizeError) -> String {
    match error {
        FinalizeError::Finalize(error) => {
            tracing::error!(error = %error, "model_finalize_error");
            format!("Failed to finalize model: {}", error)
        }
        FinalizeError::Join(error) => {
            tracing::error!(error = %error, "model_finalize_join_error");
            format!("Finalization interrupted: {}", error)
        }
    }
}
