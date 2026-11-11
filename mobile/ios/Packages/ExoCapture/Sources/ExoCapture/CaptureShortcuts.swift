import CaptureCore
import Foundation

/// A recording started outside the app's own Record button. The raw value is the session `source`, one of the
/// web app's `CaptureSource` values (frontend/src/lib/voiceNotes/nativeVoiceNotes.ts); notes from any of them
/// are held for transcription consent.
public enum ShortcutSource: String, CaseIterable, Sendable {
    /// The home-screen quick action (long-press the app icon, Record).
    case quickAction = "quick_action"
    /// An App Shortcut: Siri, Spotlight, the Shortcuts app or the Action button.
    case intent
    /// The Control Center / Lock Screen control.
    case control
}

public enum ShortcutStartOutcome: Equatable, Sendable {
    case started(id: String)
    /// A recording was already live (or stopping); the recorder is shown for it instead of starting another.
    case presentedExisting(id: String?)
}

extension CaptureEngine {
    /// The one native start every shortcut uses. It needs no scene or WebView: a WebView already listening gets
    /// `presentRecorder`, and one that attaches later reads `status()` and presents any live recording whose
    /// source is not `in_app` (frontend voiceNoteRecorderController).
    @discardableResult
    public func startFromShortcut(_ source: ShortcutSource) throws -> ShortcutStartOutcome {
        do {
            let started = try start(source: source.rawValue)
            guard let id = started["id"] as? String else { throw CaptureError.io("start returned no id") }
            return .started(id: id)
        } catch CaptureError.alreadyRecording {
            presentRecorder()
            return .presentedExisting(id: status()["id"] as? String)
        }
    }
}
