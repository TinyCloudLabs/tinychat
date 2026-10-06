use tokio::fs;

use crate::download_task::params::DownloadTaskParams;
use crate::model::DownloadableModel;

/// What happens to the partial file when a download task ends without
/// installing the model.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PartialFile {
    /// Keep it: the next attempt resumes from it, and the checksum still gates
    /// installation.
    Keep,
    /// Delete it: it failed verification, or nothing could verify a resume.
    Delete,
}

pub(super) async fn cleanup_for_failure<M: DownloadableModel>(
    params: &DownloadTaskParams<M>,
    partial: PartialFile,
) {
    if partial == PartialFile::Delete {
        let _ = fs::remove_file(&params.destination).await;
    }
    params
        .registry
        .remove_if_generation_matches(&params.key, params.generation)
        .await;
}
