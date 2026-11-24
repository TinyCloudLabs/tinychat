//! In-app updates (TC-4275). The bundled app checks the stable release's latest.json (tauri.conf.json
//! plugins.updater) at launch and every 4 hours of wall-clock time, downloads a newer version in the background
//! (tauri-plugin-updater verifies its signature against a pinned public key), and only then offers
//! "Restart to update". The offer is withheld while a recording is in progress or a stopped recording is still
//! being finished, and the restart command refuses then too: an update never interrupts a recording. Updater
//! failures are logged and otherwise silent; the next check retries.
//!
//! Two keys are trusted: plugins.updater.pubkey, which releases are signed with, and plugins.updater.backupPubkey,
//! an offline key kept for rotation. If the primary key is lost or leaks, a release signed with the backup key
//! (carrying a new pair) still updates every install, with no manual step. The plugin verifies with one key, so the
//! signature's minisign key id picks which trusted key it is verified with; a signature that names a trusted key
//! it was not made with still fails that verification.
//!
//! The webview gets no updater plugin permission: it can only read the offer and ask for the restart.
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The offer changed: payload is the offer, or null when it is withdrawn.
pub const PROMPT_EVENT: &str = "exo://update-prompt";
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// How often a due check is looked for. Wall-clock comparison, because the monotonic clock stops while the Mac
/// sleeps.
const CHECK_TICK: Duration = Duration::from_secs(60);
/// How often the offer follows the recording state.
const PROMPT_TICK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    version: String,
}

/// Whether "Restart to update" is on screen. Pure, so the deferral is unit-tested without an app.
#[derive(Debug, Default)]
pub struct Gate {
    shown: Option<Prompt>,
}

impl Gate {
    /// The offer for a downloaded `version` given whether recording is in progress. Returns the new offer when it
    /// changed (to emit), `None` when it did not.
    pub fn observe(&mut self, downloaded: Option<&str>, recording: bool) -> Option<Option<Prompt>> {
        let next = match downloaded {
            Some(version) if !recording => Some(Prompt {
                version: version.to_owned(),
            }),
            _ => None,
        };
        if next == self.shown {
            return None;
        }
        self.shown = next.clone();
        Some(next)
    }

    pub fn shown(&self) -> Option<Prompt> {
        self.shown.clone()
    }
}

struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct DesktopUpdate {
    downloaded: Mutex<Option<Downloaded>>,
    gate: Mutex<Gate>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// A recording is live, paused, starting or stopping, or a stopped one is not finished yet (the same journal the
/// quit guard reads).
fn recording_in_progress(app: &tauri::AppHandle) -> bool {
    #[cfg(feature = "transcription")]
    {
        crate::FINISHING_QUIT.load(std::sync::atomic::Ordering::SeqCst)
            || crate::recorder::engine::recording_in_progress(app)
    }
    #[cfg(not(feature = "transcription"))]
    {
        let _ = app;
        false
    }
}

/// Only an installed app bundle updates itself: not `cargo run`, not CI's bare release binary.
fn bundled() -> bool {
    std::env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

pub fn install(app: &tauri::App) {
    app.manage(DesktopUpdate::default());
    if cfg!(debug_assertions) || !bundled() {
        return;
    }
    let checker = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let mut next_check = SystemTime::UNIX_EPOCH;
        loop {
            if SystemTime::now() >= next_check {
                next_check = SystemTime::now() + CHECK_EVERY;
                if let Err(error) = check_and_download(&checker).await {
                    tracing::warn!(target: "exo_dev::updater", operation = "check", error = %error);
                }
            }
            tokio::time::sleep(CHECK_TICK).await;
        }
    });
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            refresh_prompt(&app);
            tokio::time::sleep(PROMPT_TICK).await;
        }
    });
}

type CheckError = Box<dyn std::error::Error + Send + Sync>;

async fn check_and_download(app: &tauri::AppHandle) -> Result<(), CheckError> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let state = app.state::<DesktopUpdate>();
    if lock(&state.downloaded)
        .as_ref()
        .is_some_and(|downloaded| downloaded.update.version == update.version)
    {
        return Ok(());
    }
    let trusted = trusted_keys(app);
    let Some(key) = trusted_key_for(&update.signature, &trusted) else {
        return Err(format!("{} is not signed by a key this app trusts", update.version).into());
    };
    // The check above ran with the primary key (tauri.conf.json); the download verifies with the key the signature
    // names, so a backup-signed release needs an updater built with that key. latest.json must be unchanged.
    let update = if key == trusted[0] {
        update
    } else {
        let Some(again) = app.updater_builder().pubkey(key).build()?.check().await? else {
            return Ok(());
        };
        if again.signature != update.signature {
            return Err("latest.json changed between checks".into());
        }
        again
    };
    let bytes = update.download(|_, _| {}, || {}).await?;
    tracing::info!(target: "exo_dev::updater", operation = "download", version = %update.version);
    *lock(&state.downloaded) = Some(Downloaded { update, bytes });
    Ok(())
}

/// plugins.updater.pubkey, then plugins.updater.backupPubkey.
fn trusted_keys(app: &tauri::AppHandle) -> Vec<String> {
    let updater = app.config().plugins.0.get("updater");
    ["pubkey", "backupPubkey"]
        .into_iter()
        .filter_map(|field| Some(updater?.get(field)?.as_str()?.to_owned()))
        .collect()
}

/// The minisign key id of a Tauri updater public key or signature: base64 of minisign's text form, whose second
/// line is base64 of a 2-byte algorithm, the 8-byte key id, then the key or signature. A placeholder has none.
fn key_id(wrapped: &str) -> Option<[u8; 8]> {
    use base64::Engine;
    let base64 = &base64::engine::general_purpose::STANDARD;
    let text = String::from_utf8(base64.decode(wrapped.trim()).ok()?).ok()?;
    let raw = base64.decode(text.lines().nth(1)?.trim()).ok()?;
    raw.get(2..10)?.try_into().ok()
}

/// The trusted key whose id the signature names, if any. Routing only: the updater then verifies the signature
/// with that key.
fn trusted_key_for<'a>(signature: &str, trusted: &'a [String]) -> Option<&'a str> {
    let id = key_id(signature)?;
    trusted
        .iter()
        .find(|key| key_id(key) == Some(id))
        .map(String::as_str)
}

fn refresh_prompt(app: &tauri::AppHandle) {
    let state = app.state::<DesktopUpdate>();
    let version = lock(&state.downloaded)
        .as_ref()
        .map(|downloaded| downloaded.update.version.clone());
    let change = lock(&state.gate).observe(version.as_deref(), recording_in_progress(app));
    if let Some(prompt) = change {
        if let Err(error) = app.emit(PROMPT_EVENT, prompt) {
            tracing::warn!(target: "exo_dev::updater", operation = "emit", error = %error);
        }
    }
}

/// The current offer, for a webview that subscribed after it was emitted.
#[tauri::command]
pub async fn desktop_update_status(app: tauri::AppHandle) -> Option<Prompt> {
    lock(&app.state::<DesktopUpdate>().gate).shown()
}

/// "Restart to update": install the downloaded version and relaunch. Refused while recording; the offer comes back
/// once recording is idle.
#[tauri::command]
pub async fn desktop_update_restart(app: tauri::AppHandle) -> Result<(), String> {
    if recording_in_progress(&app) {
        refresh_prompt(&app);
        return Err("recording_in_progress".into());
    }
    let Some(downloaded) = lock(&app.state::<DesktopUpdate>().downloaded).take() else {
        return Err("no_update".into());
    };
    let version = downloaded.update.version.clone();
    let installed =
        tauri::async_runtime::spawn_blocking(move || downloaded.update.install(&downloaded.bytes))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|error| error.to_string()));
    refresh_prompt(&app);
    if let Err(error) = installed {
        tracing::warn!(target: "exo_dev::updater", operation = "install", %version, %error);
        return Err("install_failed".into());
    }
    // Installed on disk. A recording that started during the install is never cut short: the new version then
    // starts with the next launch.
    if recording_in_progress(&app) {
        return Err("recording_in_progress".into());
    }
    tracing::info!(target: "exo_dev::updater", operation = "restart", %version);
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{key_id, trusted_key_for, Gate, Prompt};
    use base64::Engine;

    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
    const FIXTURES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/__tests__/fixtures"
    );

    fn fixture(path: &str) -> Vec<u8> {
        std::fs::read(format!("{FIXTURES}/{path}")).unwrap()
    }

    fn fixture_text(path: &str) -> String {
        String::from_utf8(fixture(path)).unwrap()
    }

    /// What check_and_download does before the plugin's download: pick the trusted key the signature names, then
    /// verify as tauri-plugin-updater's verify_signature does (minisign-verify, legacy signatures allowed).
    fn verifies(data: &[u8], signature: &str, trusted: &[String]) -> bool {
        let Some(key) = trusted_key_for(signature, trusted) else {
            return false;
        };
        let text = |wrapped: &str| String::from_utf8(B64.decode(wrapped.trim()).unwrap()).unwrap();
        let public_key = minisign_verify::PublicKey::decode(&text(key)).unwrap();
        let signature = minisign_verify::Signature::decode(&text(signature)).unwrap();
        public_key.verify(data, &signature, true).is_ok()
    }

    /// Primary: the release script's key (desktop-updater-signature.json). Backup: the key tauri-cli 2.11.4
    /// generated (desktop-updater-tauri-cli). Neither: the script-generated release-format key
    /// (desktop-updater-generated).
    fn trusted() -> Vec<String> {
        let script: serde_json::Value =
            serde_json::from_slice(&fixture("desktop-updater-signature.json")).unwrap();
        vec![
            script["pubkey"].as_str().unwrap().to_owned(),
            fixture_text("desktop-updater-tauri-cli/test-only.key.pub"),
        ]
    }

    #[test]
    fn a_release_signed_with_the_primary_key_verifies() {
        let script: serde_json::Value =
            serde_json::from_slice(&fixture("desktop-updater-signature.json")).unwrap();
        let signature = script["signature"].as_str().unwrap();
        let trusted = trusted();
        assert_eq!(
            trusted_key_for(signature, &trusted),
            Some(trusted[0].as_str())
        );
        assert!(verifies(
            script["data"].as_str().unwrap().as_bytes(),
            signature,
            &trusted
        ));
    }

    #[test]
    fn a_release_signed_with_the_backup_key_verifies() {
        let signature = fixture_text("desktop-updater-tauri-cli/payload.bin.sig");
        let trusted = trusted();
        assert_eq!(
            trusted_key_for(&signature, &trusted),
            Some(trusted[1].as_str())
        );
        assert!(verifies(
            &fixture("desktop-updater-tauri-cli/payload.bin"),
            &signature,
            &trusted
        ));
        assert!(!verifies(b"tampered", &signature, &trusted));
    }

    #[test]
    fn a_release_signed_with_neither_key_is_refused() {
        let data = fixture("desktop-updater-generated/payload.bin");
        let signature = fixture_text("desktop-updater-generated/payload.bin.sig");
        let trusted = trusted();
        // A valid signature by an untrusted key names no trusted key: nothing is downloaded.
        assert_eq!(trusted_key_for(&signature, &trusted), None);
        assert!(!verifies(&data, &signature, &trusted));
        // The same signature relabelled with each trusted key's id is routed to that key, which rejects it.
        let text = String::from_utf8(B64.decode(signature.trim()).unwrap()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for key in &trusted {
            let mut signature_box = B64.decode(lines[1]).unwrap();
            signature_box[2..10].copy_from_slice(&key_id(key).unwrap());
            let mut forged_lines = lines.clone();
            let forged_box = B64.encode(&signature_box);
            forged_lines[1] = &forged_box;
            let forged = B64.encode(format!("{}\n", forged_lines.join("\n")));
            assert_eq!(trusted_key_for(&forged, &trusted), Some(key.as_str()));
            assert!(!verifies(&data, &forged, &trusted));
        }
        // A placeholder key is trusted by nobody's signature.
        assert_eq!(
            key_id("PLACEHOLDER-TC-4275-replace-with-the-minted-updater-public-key-before-merge"),
            None
        );
    }

    fn prompt(version: &str) -> Option<Prompt> {
        Some(Prompt {
            version: version.to_owned(),
        })
    }

    #[test]
    fn no_restart_prompt_while_recording() {
        let mut gate = Gate::default();
        assert_eq!(gate.observe(Some("1.4.0"), true), None);
        assert_eq!(gate.shown(), None);
        // Still recording on later ticks: still nothing.
        assert_eq!(gate.observe(Some("1.4.0"), true), None);
        assert_eq!(gate.shown(), None);
    }

    #[test]
    fn prompt_waits_for_idle_and_withdraws_when_recording_starts() {
        let mut gate = Gate::default();
        assert_eq!(gate.observe(None, false), None);
        assert_eq!(gate.observe(Some("1.4.0"), true), None);
        assert_eq!(gate.observe(Some("1.4.0"), false), Some(prompt("1.4.0")));
        assert_eq!(gate.observe(Some("1.4.0"), false), None);
        assert_eq!(gate.shown(), prompt("1.4.0"));
        assert_eq!(gate.observe(Some("1.4.0"), true), Some(None));
        assert_eq!(gate.shown(), None);
        assert_eq!(gate.observe(Some("1.4.0"), false), Some(prompt("1.4.0")));
    }

    #[test]
    fn a_newer_download_replaces_the_offer_and_an_install_clears_it() {
        let mut gate = Gate::default();
        assert_eq!(gate.observe(Some("1.4.0"), false), Some(prompt("1.4.0")));
        assert_eq!(gate.observe(Some("1.5.0"), false), Some(prompt("1.5.0")));
        assert_eq!(gate.observe(None, false), Some(None));
    }

    /// scripts/release/desktop-updater.mjs signs release archives with Node's crypto; this is the verifier
    /// tauri-plugin-updater runs (minisign-verify, base64 of the minisign boxes) on a signature it produced
    /// (scripts/__tests__/desktop-updater.test.mjs checks the script still produces exactly this signature).
    #[test]
    fn release_script_signatures_verify_like_the_updater() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../scripts/__tests__/fixtures/desktop-updater-signature.json"
        ))
        .unwrap();
        let text = |key: &str| {
            String::from_utf8(B64.decode(fixture[key].as_str().unwrap()).unwrap()).unwrap()
        };
        let public_key = minisign_verify::PublicKey::decode(&text("pubkey")).unwrap();
        let signature = minisign_verify::Signature::decode(&text("signature")).unwrap();
        let data = fixture["data"].as_str().unwrap().as_bytes();
        public_key.verify(data, &signature, false).unwrap();
        assert!(signature
            .trusted_comment()
            .split('\t')
            .any(|field| field == format!("version:{}", fixture["version"].as_str().unwrap())));
        assert!(public_key.verify(b"tampered", &signature, false).is_err());
    }
}
