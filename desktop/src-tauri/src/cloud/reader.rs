//! Descriptor-based reads (`pread`): the hash and the upload come from the
//! file the registry opened, whatever the path points at now.

use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;

use sha2::{Digest, Sha256};

use super::registry::FileStamp;
use super::CloudError;

/// Upload chunk size.
pub const CHUNK_BYTES: usize = 256 * 1024;

/// Reads exactly `len` bytes at `offset`; a short file is an error.
pub fn read_chunk(file: &File, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    file.read_exact_at(&mut buf, offset)?;
    Ok(buf)
}

/// SHA-256 of the first `size` bytes of the descriptor.
pub fn sha256_hex(file: &File, size: u64) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut offset = 0u64;
    while offset < size {
        let len = CHUNK_BYTES.min((size - offset) as usize);
        hasher.update(read_chunk(file, offset, len)?);
        offset += len as u64;
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Fails with `file_changed` when the descriptor's file no longer matches the
/// capture's stamp (size, mtime, inode).
pub fn ensure_unchanged(file: &File, expected: &FileStamp) -> Result<(), CloudError> {
    let now = FileStamp::of(file).map_err(|e| {
        CloudError::new(
            "capture_not_available",
            format!("Reading the recording: {e}"),
        )
    })?;
    if &now != expected {
        return Err(CloudError::new(
            "file_changed",
            "The recording changed on disk after it stopped; it was not uploaded",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::registry::open_capture;
    use crate::cloud::registry::tests::{sessions_with, SESSION};
    use std::io::Write;

    fn path(sessions: &std::path::Path) -> String {
        sessions
            .join(SESSION)
            .join("audio.mp3")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn hashes_through_the_descriptor() {
        let (_d, sessions) = sessions_with(b"abc");
        let opened = open_capture(&sessions, SESSION, &path(&sessions)).unwrap();
        assert_eq!(
            sha256_hex(&opened.file, opened.stamp.size).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_file_swapped_in_after_the_handle_is_never_read() {
        let (_d, sessions) = sessions_with(b"abc");
        let opened = open_capture(&sessions, SESSION, &path(&sessions)).unwrap();
        // Replace the path with a different file (new inode) after opening.
        let replacement = sessions.join(SESSION).join("swap.tmp");
        std::fs::write(&replacement, b"something else entirely").unwrap();
        std::fs::rename(&replacement, path(&sessions)).unwrap();
        // The descriptor still reads the original recording, unchanged.
        assert_eq!(read_chunk(&opened.file, 0, 3).unwrap(), b"abc");
        assert!(ensure_unchanged(&opened.file, &opened.stamp).is_ok());
    }

    #[test]
    fn an_in_place_change_is_file_changed() {
        let (_d, sessions) = sessions_with(b"abc");
        let opened = open_capture(&sessions, SESSION, &path(&sessions)).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(path(&sessions))
            .unwrap();
        f.write_all(b"def").unwrap();
        assert_eq!(
            ensure_unchanged(&opened.file, &opened.stamp)
                .unwrap_err()
                .code,
            "file_changed"
        );

        let (_d2, sessions2) = sessions_with(b"abcdef");
        let opened2 = open_capture(&sessions2, SESSION, &path(&sessions2)).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(path(&sessions2))
            .unwrap()
            .set_len(2)
            .unwrap();
        assert_eq!(
            ensure_unchanged(&opened2.file, &opened2.stamp)
                .unwrap_err()
                .code,
            "file_changed"
        );
        assert!(
            read_chunk(&opened2.file, 0, 6).is_err(),
            "a truncated file is a short read"
        );
    }
}
