//! Only the server's own loopback socket can receive on-device audio.

pub fn trusted_whisper_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/v1"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    // url.port(), unlike port_or_known_default(), requires an explicit port.
    let port = url.port().filter(|port| *port != 0)?;
    Some(format!("http://127.0.0.1:{port}/v1"))
}

#[cfg(test)]
mod tests {
    use super::trusted_whisper_url;

    #[test]
    fn rejects_every_nonlocal_destination_and_url_smuggling() {
        assert_eq!(
            trusted_whisper_url("http://127.0.0.1:1234/v1"),
            Some("http://127.0.0.1:1234/v1".into())
        );
        for url in [
            "http://127.0.0.1:1234@evil.example/v1",
            "http://user@127.0.0.1:1234/v1",
            "http://127.0.0.1.evil.example:1234/v1",
            "https://127.0.0.1:1234/v1",
            "http://localhost:1234/v1",
            "http://[::1]:1234/v1",
            "http://127.0.0.1/v1",
            "http://127.0.0.1:0/v1",
            "http://127.0.0.1:1234/v2",
            "http://127.0.0.1:1234/v1?x=1",
            "http://127.0.0.1:1234/v1#frag",
        ] {
            assert_eq!(trusted_whisper_url(url), None, "{url}");
        }
    }
}
