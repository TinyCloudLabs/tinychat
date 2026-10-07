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
            "models": [],
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
        let threads = call.getArray("threads", Int.self) ?? [2, 4]
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
