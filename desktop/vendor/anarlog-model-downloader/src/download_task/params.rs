use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::download_task::RetryPolicy;
use crate::downloads_registry::DownloadsRegistry;
use crate::model::DownloadableModel;
use crate::runtime::ModelDownloaderRuntime;

pub(crate) struct DownloadTaskParams<M: DownloadableModel> {
    pub(crate) runtime: Arc<dyn ModelDownloaderRuntime<M>>,
    pub(crate) registry: DownloadsRegistry,
    pub(crate) model: M,
    /// Primary URL first, then fallback hosts serving the same bytes.
    pub(crate) urls: Vec<String>,
    pub(crate) retry_policy: RetryPolicy,
    pub(crate) destination: PathBuf,
    pub(crate) final_destination: PathBuf,
    pub(crate) models_base: PathBuf,
    pub(crate) key: String,
    pub(crate) generation: u64,
    pub(crate) cancellation_token: CancellationToken,
}
