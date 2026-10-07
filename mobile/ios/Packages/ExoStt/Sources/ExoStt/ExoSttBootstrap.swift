import Foundation

public enum ExoSttBootstrap {
    /// T23 adds queue reconciliation and BGTask registration here. Keep launch synchronous.
    public static func start() {
        #if EXO_STT_BENCH
        if ProcessInfo.processInfo.environment["EXO_STT_BENCH"] == "1" {
            DispatchQueue.global(qos: .utility).async {
                let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/stt-bench")
                do {
                    let result = try SttBenchmark.run(directory: directory, threads: [2, 4])
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

public enum ModelDownloads {
    /// T13 owns the background sessions. Returning false keeps unrelated sessions visible.
    public static func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) -> Bool {
        false
    }
}
