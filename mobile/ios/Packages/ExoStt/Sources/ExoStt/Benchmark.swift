#if EXO_STT_BENCH
import AVFoundation
import Darwin
import Foundation
import SherpaOnnx
import SttCore

public enum SttBenchmarkError: Error {
    case missingFixture(String)
    case invalidAudio(String)
    case invalidThreads
}

public enum SttBenchmark {
    /// Runs only in an explicitly flagged benchmark build. No model is bundled in the app.
    public static func run(directory: URL, threads: [Int]) throws -> [String: Any] {
        guard !threads.isEmpty, threads.allSatisfy({ $0 == 2 || $0 == 4 }) else {
            throw SttBenchmarkError.invalidThreads
        }
        let output = directory.appendingPathComponent("results/ios", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var summary: [[String: Any]] = []
        for name in ["ls-1089-10m", "ami-es2004a-10m", "ls-alt-2spk-10m"] {
            let samples = try readWav(directory.appendingPathComponent("\(name).wav"))
            for threadCount in threads {
                let model = directory.appendingPathComponent("models/full", isDirectory: true)
                let result = try recognize(samples: samples, model: model, threads: threadCount)
                let stem = threadCount == 4 ? name : "\(name)-t\(threadCount)"
                try result.text.write(to: output.appendingPathComponent("\(stem).hyp.txt"), atomically: true, encoding: .utf8)
                try writeJSON(result.words, to: output.appendingPathComponent("\(stem).words.json"))
                var metrics: [String: Any] = [
                    "fixture": name, "threads": threadCount, "audioSeconds": Double(samples.count) / 16_000,
                    "loadSeconds": result.loadSeconds, "decodeSeconds": result.decodeSeconds,
                    "rtf": result.decodeSeconds / (Double(samples.count) / 16_000),
                    "peakPhysFootprintBytes": result.peakPhysFootprintBytes
                ]
                if name != "ls-1089-10m" {
                    let diar = try diarize(samples: samples, model: directory.appendingPathComponent("models/diarization"), threads: threadCount)
                    try diar.rttm.write(to: output.appendingPathComponent("\(stem).rttm"), atomically: true, encoding: .utf8)
                    metrics["diarizationSeconds"] = diar.seconds
                    metrics["maxWindowSeconds"] = diar.maxWindowSeconds
                    metrics["diarizationExtraFootprintBytes"] = diar.peakPhysFootprintBytes > result.peakPhysFootprintBytes
                        ? diar.peakPhysFootprintBytes - result.peakPhysFootprintBytes : 0
                } else {
                    try "".write(to: output.appendingPathComponent("\(stem).rttm"), atomically: true, encoding: .utf8)
                }
                let metricData = try JSONSerialization.data(withJSONObject: metrics, options: [.prettyPrinted, .sortedKeys])
                try metricData.write(to: output.appendingPathComponent("\(stem).metrics.json"), options: .atomic)
                summary.append(metrics)
            }
        }
        return ["results": summary, "output": output.path]
    }

    private static func readWav(_ url: URL) throws -> [Float] {
        guard FileManager.default.fileExists(atPath: url.path) else { throw SttBenchmarkError.missingFixture(url.path) }
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        guard format.sampleRate == 16_000, format.channelCount == 1,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
            throw SttBenchmarkError.invalidAudio(url.path)
        }
        try file.read(into: buffer)
        guard let channel = buffer.floatChannelData?[0] else { throw SttBenchmarkError.invalidAudio(url.path) }
        return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }

    private struct Recognition {
        let text: String
        let words: [TimedWord]
        let loadSeconds: Double
        let decodeSeconds: Double
        let peakPhysFootprintBytes: UInt64
    }

    private static func recognize(samples: [Float], model: URL, threads: Int) throws -> Recognition {
        for file in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] {
            guard FileManager.default.fileExists(atPath: model.appendingPathComponent(file).path) else {
                throw SttBenchmarkError.missingFixture(model.appendingPathComponent(file).path)
            }
        }
        let loadStart = CFAbsoluteTimeGetCurrent()
        let modelConfig = sherpaOnnxOfflineModelConfig(
            tokens: model.appendingPathComponent("tokens.txt").path,
            transducer: sherpaOnnxOfflineTransducerModelConfig(
                encoder: model.appendingPathComponent("encoder.int8.onnx").path,
                decoder: model.appendingPathComponent("decoder.int8.onnx").path,
                joiner: model.appendingPathComponent("joiner.int8.onnx").path),
            numThreads: threads, provider: "cpu", modelType: "nemo_transducer")
        var config = sherpaOnnxOfflineRecognizerConfig(featConfig: sherpaOnnxFeatureConfig(),
                                                       modelConfig: modelConfig, decodingMethod: "greedy_search")
        let recognizer = SherpaOnnxOfflineRecognizer(config: &config)
        let loaded = CFAbsoluteTimeGetCurrent()
        var peak = footprint()
        var texts: [String] = []
        var words: [TimedWord] = []
        let chunk = 25 * 16_000
        for offset in stride(from: 0, to: samples.count, by: chunk) {
            let result = recognizer.decode(samples: Array(samples[offset..<min(offset + chunk, samples.count)]))
            peak = max(peak, footprint())
            texts.append(result.text)
            let tokens = result.text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            for (index, token) in tokens.enumerated() {
                let start = index < result.timestamps.count ? Double(result.timestamps[index]) : 0
                let duration = index < result.durations.count ? Double(result.durations[index]) : 0
                let origin = Double(offset) / 16_000
                words.append(.init(start: origin + start, end: origin + start + max(0, duration), text: token))
            }
        }
        return Recognition(text: texts.joined(separator: " "), words: words,
                           loadSeconds: loaded - loadStart, decodeSeconds: CFAbsoluteTimeGetCurrent() - loaded,
                           peakPhysFootprintBytes: peak)
    }

    private struct Diarization {
        let rttm: String
        let seconds: Double
        let maxWindowSeconds: Double
        let peakPhysFootprintBytes: UInt64
    }

    private static func diarize(samples: [Float], model: URL, threads: Int) throws -> Diarization {
        let seg = model.appendingPathComponent("model.int8.onnx").path
        let embedding = model.appendingPathComponent("3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx").path
        for path in [seg, embedding] where !FileManager.default.fileExists(atPath: path) {
            throw SttBenchmarkError.missingFixture(path)
        }
        var config = sherpaOnnxOfflineSpeakerDiarizationConfig(
            segmentation: sherpaOnnxOfflineSpeakerSegmentationModelConfig(
                pyannote: sherpaOnnxOfflineSpeakerSegmentationPyannoteModelConfig(model: seg), numThreads: threads),
            embedding: sherpaOnnxSpeakerEmbeddingExtractorConfig(model: embedding, numThreads: threads),
            clustering: sherpaOnnxFastClusteringConfig(threshold: 0.5))
        let diarizer = SherpaOnnxOfflineSpeakerDiarizationWrapper(config: &config)
        let start = CFAbsoluteTimeGetCurrent()
        var maxWindow = 0.0
        var peak = footprint()
        var lines: [String] = []
        let window = 60 * 16_000
        for offset in stride(from: 0, to: samples.count, by: window) {
            let began = CFAbsoluteTimeGetCurrent()
            let turns = diarizer.process(samples: Array(samples[offset..<min(offset + window, samples.count)]))
            peak = max(peak, footprint())
            maxWindow = max(maxWindow, CFAbsoluteTimeGetCurrent() - began)
            for turn in turns {
                let origin = Double(offset) / 16_000
                lines.append(String(format: "SPEAKER benchmark 1 %.3f %.3f <NA> <NA> speaker_%d <NA> <NA>",
                                    origin + Double(turn.start), Double(turn.end - turn.start), turn.speaker))
            }
        }
        return Diarization(rttm: lines.joined(separator: "\n") + "\n",
                           seconds: CFAbsoluteTimeGetCurrent() - start, maxWindowSeconds: maxWindow,
                           peakPhysFootprintBytes: peak)
    }

    private static func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }

    private static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }
}
#endif
