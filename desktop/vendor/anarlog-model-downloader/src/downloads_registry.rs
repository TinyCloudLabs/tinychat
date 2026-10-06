use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub(crate) struct DownloadsRegistry {
    inner: Arc<Mutex<HashMap<String, DownloadEntry>>>,
}

pub(crate) struct DownloadEntry {
    pub(crate) task: JoinHandle<()>,
    pub(crate) token: CancellationToken,
    pub(crate) generation: u64,
    pub(crate) download_path: PathBuf,
}

impl DownloadsRegistry {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Whether a live download task is registered for `key`. An entry whose
    /// task already ended without removing itself (it panicked) is dropped,
    /// so it cannot block later downloads of the model.
    pub(crate) async fn is_running(&self, key: &str) -> bool {
        let mut guard = self.inner.lock().await;
        match guard.get(key) {
            Some(entry) if entry.task.is_finished() => {
                guard.remove(key);
                false
            }
            Some(_) => true,
            None => false,
        }
    }

    pub(crate) async fn insert(&self, key: String, entry: DownloadEntry) -> Option<DownloadEntry> {
        self.inner.lock().await.insert(key, entry)
    }

    pub(crate) async fn remove(&self, key: &str) -> Option<DownloadEntry> {
        self.inner.lock().await.remove(key)
    }

    pub(crate) async fn remove_if_generation_matches(&self, key: &str, generation: u64) {
        let mut guard = self.inner.lock().await;
        if guard
            .get(key)
            .is_some_and(|entry| entry.generation == generation)
        {
            guard.remove(key);
        }
    }
}

impl Clone for DownloadsRegistry {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}
