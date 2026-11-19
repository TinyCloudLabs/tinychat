#if os(iOS)
import ExoCapture
#endif
import Foundation

public enum ExoSttBootstrap {
    #if os(iOS)
    private static var observer: UUID?
    #endif

    /// BGTask registration (T23) is not added in this slice: on-device transcription only runs
    /// while the app process is alive (TC-836 report, deviations). Keep launch synchronous.
    public static func start() {
        #if os(iOS)
        if observer == nil {
            observer = CaptureEngine.shared.observe { name, _, _ in
                guard name == "committed" else { return }
                TranscriptionQueue.shared.reconcile()
            }
            // Capture-priority handoff (plan §2.5, round-2 finding 3 override): ExoCapture can't
            // depend on ExoStt directly (ExoStt already depends on ExoCapture, so that would be a
            // package cycle), so the queue registers itself here instead. Neither call blocks.
            CaptureEngine.shared.captureSessionStarted = { TranscriptionQueue.shared.captureStarted() }
            CaptureEngine.shared.captureSessionEnded = { TranscriptionQueue.shared.captureEnded() }
        }
        TranscriptionQueue.shared.recoverInterruptedReruns()
        removeDownloadedModels()
        // Picks up notes committed in an earlier process run (app killed mid-transcription, or
        // committed before the speech assets were installed): re-queued here instead of resumed
        // mid-file.
        TranscriptionQueue.shared.reconcile()
        #endif
    }

    #if os(iOS)
    /// Builds before TC-919 transcribed with a downloaded Parakeet model (~640 MB) kept under
    /// Application Support/models; Apple's built-in speech replaced it, so any left on this phone is deleted.
    private static func removeDownloadedModels() {
        UserDefaults.standard.removeObject(forKey: "exo.stt.autoDownload")
        let models = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("models", isDirectory: true)
        DispatchQueue.global(qos: .utility).async {
            guard FileManager.default.fileExists(atPath: models.path) else { return }
            do { try FileManager.default.removeItem(at: models) }
            catch { NSLog("ExoStt could not remove the old downloaded models: %@", String(describing: error)) }
        }
    }
    #endif
}
