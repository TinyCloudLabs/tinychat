import Capacitor
import ExoStt
import Foundation

@objc(OnDeviceSttPlugin)
public final class OnDeviceSttPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OnDeviceSttPlugin"
    public let jsName = "OnDeviceStt"
    public var pluginMethods: [CAPPluginMethod] {
        var methods: [CAPPluginMethod] = [CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)]
        #if EXO_STT_BENCH
        methods.append(CAPPluginMethod(name: "benchmark", returnType: CAPPluginReturnPromise))
        #endif
        return methods
    }

    @objc public func status(_ call: CAPPluginCall) {
        call.resolve([
            "models": [
                ["id": "parakeet-tdt-0.6b-v3-int8", "state": "absent", "bytes": 0, "totalBytes": 670_478_772, "error": NSNull()],
                ["id": "parakeet-tdt-110m-en-int8", "state": "absent", "bytes": 0, "totalBytes": 136_490_421, "error": NSNull()],
                ["id": "silero-vad", "state": "absent", "bytes": 0, "totalBytes": 643_854, "error": NSNull()],
                ["id": "diarization", "state": "absent", "bytes": 0, "totalBytes": 31_137_484, "error": NSNull()]
            ],
            "pack": ProcessInfo.processInfo.physicalMemory >= 6_000_000_000 ? "full" : "small",
            "autoDownload": false,
            "download": ["policy": "wifi", "state": "idle"],
            "engine": "none",
            "appleSpeech": "unsupported",
            "queue": []
        ])
    }

    #if EXO_STT_BENCH
    @objc public func benchmark(_ call: CAPPluginCall) {
        guard let relative = call.getString("dir"), relative == "Documents/stt-bench" else {
            call.reject("Benchmark directory must be Documents/stt-bench", "invalid_directory")
            return
        }
        let threads = call.getArray("threads", Int.self) ?? [4, 2]
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(relative)
        DispatchQueue.global(qos: .utility).async {
            do {
                let result = try SttBenchmark.run(directory: directory, threads: threads)
                call.resolve(result)
            } catch {
                call.reject("STT benchmark failed: \(error)", "benchmark_failed", error)
            }
        }
    }
    #endif
}
