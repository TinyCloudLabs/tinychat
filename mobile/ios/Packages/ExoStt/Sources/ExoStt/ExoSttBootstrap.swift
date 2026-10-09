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
        // Picks up notes committed in an earlier process run (app killed mid-transcription, or
        // committed before the model finished downloading): re-queued here instead of resumed
        // mid-file.
        TranscriptionQueue.shared.reconcile()
        #endif
        #if EXO_STT_BENCH
        if ProcessInfo.processInfo.environment["EXO_STT_BENCH"] == "1" {
            DispatchQueue.global(qos: .utility).async {
                let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/stt-bench")
                do {
                    let result = try SttBenchmark.run(directory: directory, threads: [4, 2])
                    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                    NSLog("EXO_STT_BENCH %@", String(decoding: data, as: UTF8.self))
                } catch {
                    NSLog("EXO_STT_BENCH failed: %@", String(describing: error))
                }
            }
        }
        #endif
    }
}
