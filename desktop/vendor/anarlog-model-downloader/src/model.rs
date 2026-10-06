use std::path::Path;
use std::path::PathBuf;

use crate::Error;

pub trait DownloadableModel: Clone + Send + Sync + 'static {
    fn download_key(&self) -> String;
    fn download_url(&self) -> Option<String>;
    /// Hosts serving byte-identical copies of `download_url()`, tried in order
    /// when it fails. Used only when `download_checksum()` is set: a download
    /// may resume across hosts, and the checksum is what proves the result.
    fn download_fallback_urls(&self) -> Vec<String> {
        Vec::new()
    }
    fn download_checksum(&self) -> Option<u32> {
        None
    }
    fn download_destination(&self, models_base: &Path) -> PathBuf;
    fn is_downloaded(&self, models_base: &Path) -> Result<bool, Error>;
    fn finalize_download(&self, downloaded_path: &Path, models_base: &Path) -> Result<(), Error>;
    fn delete_downloaded(&self, models_base: &Path) -> Result<(), Error>;

    fn remove_destination_after_finalize(&self) -> bool {
        false
    }
}
