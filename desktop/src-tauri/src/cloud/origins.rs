//! Compiled-in destinations. Audio is only ever sent to [`PTX_UPLOAD_ORIGIN`]
//! and the bearer only to [`BACKEND_ORIGIN`]; neither can be changed by the
//! webview or by a backend response.

use reqwest::Url;

use super::CloudError;

/// The TinyCloud Private Transcription batch origin audio may be uploaded to.
///
/// `None` in this build: the engine stays hidden (`origin_not_configured`) until
/// the `ptx-batch` CVM exists and a follow-up sets its exact gateway origin
/// (plan P7), e.g. `Some("https://<app-id>-8080.<gateway-domain>")`.
pub const PTX_UPLOAD_ORIGIN: Option<&str> = None;

/// The TinyChat backend the bundled frontend talks to (VITE_BACKEND_URL at
/// build time; see build.rs).
pub const BACKEND_ORIGIN: &str = env!("EXO_BACKEND_URL");

/// Debug builds only: a local PTX stand-in, `http://127.0.0.1:<port>` exactly.
#[cfg(debug_assertions)]
const DEBUG_PTX_ORIGIN_ENV: &str = "EXO_DEBUG_PTX_ORIGIN";

/// Crockford base32 as PTX writes ULIDs (`trn_` ids).
fn is_ulid_char(c: u8) -> bool {
    matches!(c, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
}

/// `trn_` + 26 Crockford base32 characters.
pub fn is_transcription_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("trn_") else {
        return false;
    };
    rest.len() == 26 && rest.bytes().all(is_ulid_char)
}

/// `^/uploads/trn_[0-9A-HJKMNP-TV-Z]{26}$`
pub fn is_upload_path(path: &str) -> bool {
    path.strip_prefix("/uploads/")
        .is_some_and(is_transcription_id)
}

/// Parses an origin: scheme + host (+ port) and nothing else — no userinfo,
/// path, query or fragment. `https` only, except `http://127.0.0.1:<port>`
/// when `allow_loopback_http`.
pub fn parse_origin(raw: &str, allow_loopback_http: bool) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("not a URL: {e}"))?;
    match url.scheme() {
        "https" => {}
        "http" if allow_loopback_http => {
            if url.host_str() != Some("127.0.0.1") || url.port().is_none() {
                return Err("http is only allowed for http://127.0.0.1:<port>".into());
            }
        }
        other => return Err(format!("scheme {other} is not allowed")),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("missing host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("userinfo is not allowed".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("query and fragment are not allowed".into());
    }
    // `Url` normalizes an empty path to "/"; anything longer is a path.
    if url.path() != "/"
        || raw.trim_end_matches('/').len() != url.origin().ascii_serialization().len()
    {
        return Err("a path is not allowed".into());
    }
    Ok(url)
}

/// The PTX origin this build uploads to, or `origin_not_configured`.
pub fn ptx_upload_origin() -> Result<Url, CloudError> {
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var(DEBUG_PTX_ORIGIN_ENV) {
        return parse_origin(&raw, true).map_err(|e| {
            CloudError::new(
                "origin_not_configured",
                format!("{DEBUG_PTX_ORIGIN_ENV}: {e}"),
            )
        });
    }
    resolve_ptx_origin(PTX_UPLOAD_ORIGIN)
}

fn resolve_ptx_origin(compiled: Option<&str>) -> Result<Url, CloudError> {
    let raw = compiled.ok_or_else(|| {
        CloudError::new(
            "origin_not_configured",
            "Private cloud transcription is not available in this build",
        )
    })?;
    parse_origin(raw, false)
        .map_err(|e| CloudError::new("origin_not_configured", format!("PTX origin: {e}")))
}

/// Joins a backend-issued relative upload path to the compiled PTX origin.
/// Anything but `/uploads/trn_…` is refused, so the result is always on `origin`.
pub fn upload_url(origin: &Url, path: &str) -> Result<Url, CloudError> {
    if !is_upload_path(path) {
        return Err(CloudError::new(
            "upstream_bad_response",
            "The upload path is not a PTX upload path",
        ));
    }
    let url = origin
        .join(path)
        .map_err(|e| CloudError::new("upstream_bad_response", format!("upload path: {e}")))?;
    if url.origin() != origin.origin() || url.path() != path {
        return Err(CloudError::new(
            "upstream_bad_response",
            "The upload path leaves the PTX origin",
        ));
    }
    Ok(url)
}

/// The compiled backend origin.
pub fn backend_origin() -> Result<Url, CloudError> {
    parse_origin(BACKEND_ORIGIN.trim_end_matches('/'), cfg!(debug_assertions)).map_err(|e| {
        CloudError::new(
            "backend_origin_mismatch",
            format!("compiled backend origin: {e}"),
        )
    })
}

/// The webview's backend URL must be exactly the compiled one; the bearer is
/// never sent anywhere else.
pub fn check_backend_url(requested: &str, compiled: &Url) -> Result<(), CloudError> {
    let requested = parse_origin(requested.trim_end_matches('/'), cfg!(debug_assertions))
        .map_err(|e| CloudError::new("backend_origin_mismatch", format!("backend URL: {e}")))?;
    if requested.origin() != compiled.origin() {
        return Err(CloudError::new(
            "backend_origin_mismatch",
            "The backend URL does not match the one this build was made for",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";

    #[test]
    fn transcription_ids_and_upload_paths() {
        assert!(is_transcription_id(ID));
        assert!(is_upload_path(&format!("/uploads/{ID}")));
        for bad in [
            "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W",   // 25
            "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3X", // 27
            "trn_01J8Z3K4M5N6P7Q8R9S0T1V2WI",  // I is not Crockford
            "trn_01j8z3k4m5n6p7q8r9s0t1v2w3",  // lowercase
            "mtg_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
        ] {
            assert!(!is_transcription_id(bad), "{bad}");
        }
        for bad in [
            format!("/uploads/{ID}/"),
            format!("/uploads/{ID}?x=1"),
            format!("uploads/{ID}"),
            format!("//evil.example/uploads/{ID}"),
            format!("https://evil.example/uploads/{ID}"),
            format!("/uploads/../v1/{ID}"),
            format!("/v1/transcriptions/{ID}"),
        ] {
            assert!(!is_upload_path(&bad), "{bad}");
        }
    }

    #[test]
    fn origins_are_scheme_host_port_only() {
        assert!(parse_origin("https://ptx.example", false).is_ok());
        assert!(parse_origin("https://ptx.example/", false).is_ok());
        assert!(parse_origin("https://ptx.example:8443", false).is_ok());
        for bad in [
            "http://ptx.example",
            "http://127.0.0.1:8080",
            "https://user:pw@ptx.example",
            "https://user@ptx.example",
            "https://ptx.example/path",
            "https://ptx.example/?q=1",
            "https://ptx.example/#frag",
            "ftp://ptx.example",
            "not a url",
        ] {
            assert!(parse_origin(bad, false).is_err(), "{bad}");
        }
        assert!(parse_origin("http://127.0.0.1:8080", true).is_ok());
        assert!(parse_origin("http://127.0.0.1", true).is_err());
        assert!(parse_origin("http://localhost:8080", true).is_err());
        assert!(parse_origin("http://10.0.0.1:8080", true).is_err());
    }

    #[test]
    fn no_compiled_origin_means_not_configured() {
        assert_eq!(
            PTX_UPLOAD_ORIGIN, None,
            "this build must keep the engine hidden"
        );
        let err = resolve_ptx_origin(None).unwrap_err();
        assert_eq!(err.code, "origin_not_configured");
        assert_eq!(
            resolve_ptx_origin(Some("http://ptx.example"))
                .unwrap_err()
                .code,
            "origin_not_configured"
        );
        assert!(resolve_ptx_origin(Some("https://ptx.example")).is_ok());
    }

    #[test]
    fn upload_urls_stay_on_the_compiled_origin() {
        let origin = parse_origin("https://ptx.example", false).unwrap();
        let url = upload_url(&origin, &format!("/uploads/{ID}")).unwrap();
        assert_eq!(url.as_str(), format!("https://ptx.example/uploads/{ID}"));
        for bad in [
            format!("//evil.example/uploads/{ID}"),
            format!("https://evil.example/uploads/{ID}"),
            "/uploads/../admin".to_string(),
        ] {
            assert_eq!(
                upload_url(&origin, &bad).unwrap_err().code,
                "upstream_bad_response",
                "{bad}"
            );
        }
    }

    #[test]
    fn backend_url_must_match_the_compiled_origin() {
        let compiled = parse_origin("https://api.tinycloud.chat", false).unwrap();
        assert!(check_backend_url("https://api.tinycloud.chat", &compiled).is_ok());
        assert!(check_backend_url("https://api.tinycloud.chat/", &compiled).is_ok());
        for bad in [
            "https://evil.example",
            "https://api.tinycloud.chat.evil.example",
            "https://api.tinycloud.chat:8443",
            "https://api.tinycloud.chat/api",
        ] {
            assert_eq!(
                check_backend_url(bad, &compiled).unwrap_err().code,
                "backend_origin_mismatch",
                "{bad}"
            );
        }
    }

    #[test]
    fn compiled_backend_origin_parses() {
        assert!(backend_origin().is_ok(), "EXO_BACKEND_URL={BACKEND_ORIGIN}");
    }
}
