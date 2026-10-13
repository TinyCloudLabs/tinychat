use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

/// Where a download is written until it is verified and promoted. The name is
/// stable across attempts (upstream used `.part-<generation>`), so a failed or
/// replaced download leaves a partial file the next attempt resumes from.
pub(crate) fn partial_download_path(destination: &Path) -> PathBuf {
    let mut path = destination.to_path_buf();

    if let Some(file_name) = destination.file_name() {
        let mut partial_name = OsString::from(file_name);
        partial_name.push(".part");
        path.set_file_name(partial_name);
    } else {
        path.push("download.part");
    }

    path
}
