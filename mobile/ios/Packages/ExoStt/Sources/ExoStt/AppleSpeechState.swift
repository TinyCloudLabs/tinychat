import Foundation

/// Whether this phone can transcribe with Apple's built-in on-device speech right now. The raw values
/// are the `appleSpeech` strings of `OnDeviceStt.status()`.
public enum AppleSpeechState: String {
    /// The phone has no on-device speech model for any language.
    case unsupported
    /// The phone has on-device speech, but not for the language it is set to.
    case localeUnsupported = "locale_unsupported"
    /// Supported, but the OS has not installed this language's speech assets yet.
    case assetMissing = "asset_missing"
    case ready
}

/// Progress of an explicit asset install, as `status().download.state` reports it.
public enum AppleSpeechInstall: String {
    case idle, running, failed
}
