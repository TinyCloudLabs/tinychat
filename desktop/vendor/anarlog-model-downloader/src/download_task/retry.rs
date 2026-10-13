use std::time::Duration;

/// Bounds for retrying a model download.
///
/// Each attempt resumes from the partial file the previous one left. An
/// attempt that receives nothing for `stall_timeout` is abandoned and counts as
/// a transient failure. A host is given up after `max_attempts_per_host`
/// consecutive failed attempts that each added less than `min_progress_bytes`,
/// or at once on an HTTP status that retrying the same host will not fix (a
/// 4xx other than 408/429); the next host then resumes the same partial file.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_attempts_per_host: u32,
    pub max_total_attempts: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub stall_timeout: Duration,
    pub min_progress_bytes: u64,
}

impl Default for RetryPolicy {
    /// Worst case without any progress: about 5 min per host (5 stalled
    /// attempts of 60 s plus 15 s of backoff) before the next host or the
    /// final `Failed` event.
    fn default() -> Self {
        Self {
            max_attempts_per_host: 5,
            max_total_attempts: 50,
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(60),
            min_progress_bytes: 1024 * 1024,
        }
    }
}

impl RetryPolicy {
    /// Delay before retry number `failures` (1-based) on the same host.
    pub(super) fn backoff(&self, failures: u32) -> Duration {
        let exponent = failures.saturating_sub(1).min(16);
        self.initial_backoff
            .saturating_mul(1u32 << exponent)
            .min(self.max_backoff)
    }
}

/// What to do after an attempt failed.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AfterFailure {
    /// Transient (network error, stall, 5xx, 408, 429, a 200 to a range
    /// request): retry this host.
    Retry,
    /// This host will not serve the file (403, 404, ...): try the next host.
    NextHost,
    /// Local failure (disk) or cancellation: stop.
    Stop,
}

pub(super) fn classify(error: &anlg_file::Error) -> AfterFailure {
    match error {
        anlg_file::Error::Cancelled | anlg_file::Error::FileIOError(_) => AfterFailure::Stop,
        anlg_file::Error::ReqwestError(e) => match e.status() {
            Some(status) => classify_status(status.as_u16()),
            None if e.is_builder() => AfterFailure::NextHost,
            None => AfterFailure::Retry,
        },
        // The pinned `file` crate reports unexpected HTTP statuses only as
        // text: "... (status 403 Forbidden): <url>", "... (status: 503 ...)",
        // "Download failed with status 404 Not Found: <url>".
        // The host sent more bytes than a range asked for: it is not serving
        // this file the way the download needs.
        anlg_file::Error::OtherError(message)
            if message.starts_with("Range response longer than requested") =>
        {
            AfterFailure::NextHost
        }
        anlg_file::Error::OtherError(message) => match http_status_in(message) {
            Some(status) => classify_status(status),
            None => AfterFailure::Retry,
        },
    }
}

fn classify_status(status: u16) -> AfterFailure {
    match status {
        // A 200 to a range request is transient too: under concurrent range
        // requests a CDN can serve one of them uncached as the full file
        // (seen from models.anarlog.so on Large Turbo). The retry resumes.
        200..=299 | 408 | 429 | 500..=599 => AfterFailure::Retry,
        _ => AfterFailure::NextHost,
    }
}

/// The first three-digit HTTP status following the word "status" in `message`.
pub(super) fn http_status_in(message: &str) -> Option<u16> {
    message.match_indices("status").find_map(|(index, word)| {
        let rest = message[index + word.len()..].trim_start_matches([':', ' ']);
        let digits = rest.get(..3)?;
        let next_is_digit = rest[3..].starts_with(|c: char| c.is_ascii_digit());
        if digits.bytes().all(|b| b.is_ascii_digit()) && !next_is_digit {
            digits.parse().ok()
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_status_from_every_file_crate_message() {
        assert_eq!(
            http_status_in(
                "Resource not found or inaccessible (status 403 Forbidden): https://h/x.bin"
            ),
            Some(403)
        );
        assert_eq!(
            http_status_in(
                "Server didn't return partial content (status: 503 Service Unavailable)"
            ),
            Some(503)
        );
        assert_eq!(
            http_status_in("Download failed with status 404 Not Found: https://h/x.bin"),
            Some(404)
        );
        assert_eq!(http_status_in("Download stalled: no data for 60 s"), None);
        assert_eq!(http_status_in("status 1234"), None);
    }

    #[test]
    fn classifies_statuses() {
        let other = |m: &str| anlg_file::Error::OtherError(m.to_string());
        assert_eq!(
            classify(&other("(status 403 Forbidden): u")),
            AfterFailure::NextHost
        );
        assert_eq!(
            classify(&other("(status 404 Not Found): u")),
            AfterFailure::NextHost
        );
        assert_eq!(classify(&other("(status: 200 OK)")), AfterFailure::Retry);
        assert_eq!(
            classify(&other("(status: 503 Service Unavailable)")),
            AfterFailure::Retry
        );
        assert_eq!(
            classify(&other("(status 429 Too Many Requests): u")),
            AfterFailure::Retry
        );
        assert_eq!(classify(&other("Download stalled")), AfterFailure::Retry);
        assert_eq!(
            classify(&other(
                "Range response longer than requested: more than 9 bytes for bytes=0-8"
            )),
            AfterFailure::NextHost
        );
        assert_eq!(classify(&anlg_file::Error::Cancelled), AfterFailure::Stop);
        assert_eq!(
            classify(&anlg_file::Error::FileIOError(std::io::Error::other(
                "disk full"
            ))),
            AfterFailure::Stop
        );
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let policy = RetryPolicy::default();
        let secs: Vec<u64> = (1..=7).map(|n| policy.backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 30, 30]);
    }
}
