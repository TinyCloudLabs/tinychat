import AppIntents
import Foundation
import os
#if !EXO_WIDGET_EXTENSION
import AVFoundation
import CaptureCore
import ExoCapture
#endif

// Compiled into the app and the ExoWidgets extension. The control and the Live Activity's Stop button name these
// intents; as AudioRecordingIntent + LiveActivityIntent they always perform in the app process, which owns the
// capture engine. The extension's copies only describe them.

private let intentLog = Logger(subsystem: "xyz.tinycloud.exo", category: "shortcuts")

/// The Control Center / Lock Screen control. Records in the background with the Live Activity (tapping that opens
/// the recorder); it comes forward only to ask for the microphone the first time, or when iOS refuses to start
/// the microphone in the background.
struct RecordControlIntent: AudioRecordingIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Record"
    static let description = IntentDescription("Starts recording a voice note in TinyCloud Home.")
    static let isDiscoverable = false
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]

    func perform() async throws -> some IntentResult {
        #if EXO_WIDGET_EXTENSION
        intentLog.error("EXO_SHORTCUT RecordControlIntent reached the widget extension")
        return .result()
        #else
        let context = systemContext.currentMode
        let foreground: RecordingShortcut.Foreground = context == .foreground ? .already
            : context.canContinueInForeground ? .available { try await continueInForeground(alwaysConfirm: false) }
            : .unavailable
        _ = try await RecordingShortcut.start(.control, foreground: foreground)
        return .result()
        #endif
    }
}

/// "Stop recording in TinyCloud Home", and the Live Activity's Stop button. The note is saved natively; the web
/// app picks it up like any other stopped recording.
struct StopRecordingIntent: AudioRecordingIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop Recording"
    static let description = IntentDescription("Stops and saves the voice note TinyCloud Home is recording.")
    static let supportedModes: IntentModes = .background

    func perform() async throws -> some IntentResult {
        #if EXO_WIDGET_EXTENSION
        intentLog.error("EXO_SHORTCUT StopRecordingIntent reached the widget extension")
        return .result()
        #else
        try await RecordingShortcut.stop()
        return .result()
        #endif
    }
}

#if !EXO_WIDGET_EXTENSION
/// "Start recording in TinyCloud Home": Siri, Spotlight, the Shortcuts app and the Action button.
/// Recording starts in the background (so it works from the Lock Screen, with the Live Activity), then the app
/// comes forward on the recorder when the phone allows it.
struct StartRecordingIntent: AudioRecordingIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Record a Voice Note"
    static let description = IntentDescription("Starts recording a voice note in TinyCloud Home.")
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]

    func perform() async throws -> some IntentResult {
        let context = systemContext.currentMode
        let foreground: RecordingShortcut.Foreground = context == .foreground ? .already
            : context.canContinueInForeground ? .available { try await continueInForeground(alwaysConfirm: false) }
            : .unavailable
        let landed = try await RecordingShortcut.start(.intent, foreground: foreground)
        // Land on the recorder. `start` already came forward if it had to.
        if !landed, case .available(let bringForward) = foreground { try? await bringForward() }
        return .result()
    }
}

struct TinyCloudHomeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartRecordingIntent(), phrases: [
            "Start recording in \(.applicationName)",
            "Record a note in \(.applicationName)",
            "Record a voice note in \(.applicationName)",
            "New voice note in \(.applicationName)",
            "Record in \(.applicationName)",
        ], shortTitle: "Record", systemImageName: "mic.fill")
        AppShortcut(intent: StopRecordingIntent(), phrases: [
            "Stop recording in \(.applicationName)",
        ], shortTitle: "Stop Recording", systemImageName: "stop.fill")
    }
}

enum RecordingShortcutError: Error, CustomLocalizedStringResourceConvertible {
    case microphoneDenied, microphoneNeedsApp

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .microphoneDenied: "TinyCloud Home can't use the microphone. Allow it in Settings, then try again."
        case .microphoneNeedsApp: "Open TinyCloud Home once to allow the microphone, then try again."
        }
    }
}

/// The app side of every recording shortcut: microphone permission, then the engine's shared start.
@MainActor enum RecordingShortcut {
    enum Foreground {
        /// The app is on screen (the quick action, or an intent that already runs in the foreground).
        case already
        /// The intent runs in the background and may come forward.
        case available(() async throws -> Void)
        /// Background only, for example on the Lock Screen.
        case unavailable
    }

    /// Starts (or presents) a recording. Returns whether it brought the app forward to do so.
    @discardableResult
    static func start(_ source: ShortcutSource, foreground: Foreground) async throws -> Bool {
        var cameForward = false
        switch AVAudioApplication.shared.recordPermission {
        case .granted: break
        case .denied: throw RecordingShortcutError.microphoneDenied
        default:
            // The permission prompt needs the app on screen.
            switch foreground {
            case .already: break
            case .available(let bringForward): try await bringForward(); cameForward = true
            case .unavailable: throw RecordingShortcutError.microphoneNeedsApp
            }
            guard await AVAudioApplication.requestRecordPermission() else { throw RecordingShortcutError.microphoneDenied }
        }
        let outcome: ShortcutStartOutcome
        do { outcome = try CaptureEngine.shared.startFromShortcut(source) }
        catch where isBackgroundRefusal(error) {
            // iOS would not activate the audio session in the background: retry on screen, if the app can come forward.
            guard !cameForward, case .available(let bringForward) = foreground else { throw error }
            intentLog.error("EXO_SHORTCUT background start refused, continuing in foreground: \(String(describing: error), privacy: .public)")
            try await bringForward()
            cameForward = true
            outcome = try CaptureEngine.shared.startFromShortcut(source)
        }
        switch outcome {
        case .started(let id): intentLog.notice("EXO_SHORTCUT started source=\(source.rawValue, privacy: .public) id=\(id, privacy: .public)")
        case .presentedExisting: intentLog.notice("EXO_SHORTCUT presented existing recording source=\(source.rawValue, privacy: .public)")
        }
        return cameForward
    }

    private static func isBackgroundRefusal(_ error: Error) -> Bool {
        let refusals: [AVAudioSession.ErrorCode] = [.cannotStartRecording, .insufficientPriority, .cannotInterruptOthers]
        let code = (error as NSError).code
        return refusals.contains { $0.rawValue == code }
    }

    /// Stops the live recording. Returns once the microphone is off; saving continues natively (with a background
    /// task and launch recovery), so a slow or failed save is not reported as a failed Stop.
    static func stop() throws {
        var stopping = true
        var inputError: Error?
        CaptureEngine.shared.stop { result in
            guard case .failure(let error) = result, (error as? CaptureError) != .notRecording else { return }
            if stopping { inputError = error }  // the input would not stop: the recording is still live
            else { intentLog.error("EXO_SHORTCUT stop did not save: \(String(describing: error), privacy: .public)") }
        }
        stopping = false
        if let inputError { throw inputError }
    }
}
#endif
