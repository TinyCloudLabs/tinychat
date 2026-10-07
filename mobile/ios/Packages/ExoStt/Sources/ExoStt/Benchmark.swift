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
    case invalidFixture(String)
    case invalidConfiguration(String)
    case missingTokenData
    case memoryProbeFailed
}

public enum SttBenchmark {
    /// Runs only in an explicitly flagged benchmark build. No model is bundled in the app.
    public static func run(directory: URL, threads: [Int]) throws -> [String: Any] {
        guard !threads.isEmpty, threads.allSatisfy({ $0 == 2 || $0 == 4 }),
              Set(threads).count == threads.count else {
            throw SttBenchmarkError.invalidThreads
        }
        let orderedThreads = threads.sorted(by: >) // The gate's 4-thread load is cold.
        let cap = Float(ProcessInfo.processInfo.environment["EXO_STT_BENCH_VAD_CAP_SECONDS"] ?? "25")
        guard let cap, (10...25).contains(cap) else {
            throw SttBenchmarkError.invalidConfiguration("VAD cap must be 10–25 seconds")
        }
        let threshold = Float(ProcessInfo.processInfo.environment["EXO_STT_BENCH_CLUSTER_THRESHOLD"] ?? "0.8")
        guard let threshold, (0.5...1.5).contains(threshold) else {
            throw SttBenchmarkError.invalidConfiguration("cluster threshold must be 0.5–1.5")
        }
        let hardSplit = Double(ProcessInfo.processInfo.environment["EXO_STT_BENCH_HARD_SPLIT_SECONDS"] ?? "0")
        guard let hardSplit, hardSplit == 0 || (5...25).contains(hardSplit) else {
            throw SttBenchmarkError.invalidConfiguration("hard split must be 0 or 5–25 seconds")
        }
        let blankPenalty = Float(ProcessInfo.processInfo.environment["EXO_STT_BENCH_BLANK_PENALTY"] ?? "0")
        guard let blankPenalty, blankPenalty.isFinite, (0...2).contains(blankPenalty) else {
            throw SttBenchmarkError.invalidConfiguration("blank penalty must be 0–2")
        }
        let chunkPad = Double(ProcessInfo.processInfo.environment["EXO_STT_BENCH_CHUNK_PAD_SECONDS"] ?? "0")
        guard let chunkPad, chunkPad.isFinite, (0...2).contains(chunkPad) else {
            throw SttBenchmarkError.invalidConfiguration("chunk pad must be 0–2 seconds")
        }
        let asrOnly = ProcessInfo.processInfo.environment["EXO_STT_BENCH_ASR_ONLY"] == "1"
        #if os(macOS)
        let output = directory.appendingPathComponent("results/mac", isDirectory: true)
        #else
        let output = directory.appendingPathComponent("results/ios", isDirectory: true)
        #endif
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var summary: [[String: Any]] = []
        let fixtureNames = ["ls-1089-10m", "ami-es2004a-10m", "ls-alt-2spk-10m"]
        let only = ProcessInfo.processInfo.environment["EXO_STT_BENCH_ONLY"]
        if let only, !fixtureNames.contains(only) { throw SttBenchmarkError.invalidFixture(only) }
        for name in only.map({ [$0] }) ?? fixtureNames {
            let samples = try readWav(directory.appendingPathComponent("\(name).wav"))
            let reference = try referenceText(directory: directory, fixture: name)
            for threadCount in orderedThreads {
                let model = directory.appendingPathComponent("models/full", isDirectory: true)
                let cold = summary.isEmpty
                let result = try recognize(samples: samples, model: model, threads: threadCount,
                                           vadCap: cap, hardSplit: hardSplit,
                                           blankPenalty: blankPenalty, chunkPad: chunkPad)
                let stem = threadCount == 4 ? name : "\(name)-t\(threadCount)"
                try result.text.write(to: output.appendingPathComponent("\(stem).hyp.txt"), atomically: true, encoding: .utf8)
                guard let wer = WordErrorRate.score(reference: reference, hypothesis: result.text) else {
                    throw SttBenchmarkError.invalidFixture("empty reference for \(name)")
                }
                var words = result.words
                var metrics: [String: Any] = [
                    "fixture": name, "threads": threadCount, "audioSeconds": Double(samples.count) / 16_000,
                    "loadSeconds": result.loadSeconds, "decodeSeconds": result.decodeSeconds,
                    "rtf": result.decodeSeconds / (Double(samples.count) / 16_000),
                    "peakPhysFootprintBytes": result.peakPhysFootprintBytes,
                    "asrSampledPeakPhysFootprintBytes": result.sampledPeakPhysFootprintBytes,
                    "speechSegments": result.speechSegments, "vadCapSeconds": cap,
                    "maxSpeechSegmentSeconds": result.maxSpeechSegmentSeconds,
                    "maxAsrWindowSeconds": result.maxAsrWindowSeconds,
                    "asrWindowCount": result.asrWindows.count,
                    "hardSplitSeconds": hardSplit,
                    "blankPenalty": blankPenalty, "chunkPadSeconds": chunkPad,
                    "emptyVadSegments": result.emptyVadSegments,
                    "vadCoverageSeconds": result.vadCoverageSeconds,
                    "vadSegments": result.vadSegments,
                    "asrWindows": result.asrWindows,
                    "wer": wer.rate, "werErrors": wer.errors,
                    "werReferenceWords": wer.referenceWords,
                    "werHypothesisWords": wer.hypothesisWords,
                    "vadProcessingSeconds": result.vadProcessingSeconds,
                    "coldLoad": cold
                ]
                if cold { metrics["coldLoadSeconds"] = result.loadSeconds }
                if name != "ls-1089-10m" && !asrOnly {
                    let diar = try diarize(samples: samples, model: directory.appendingPathComponent("models/diarization"),
                                           threads: threadCount, threshold: threshold)
                    try diar.rttm.write(to: output.appendingPathComponent("\(stem).rttm"), atomically: true, encoding: .utf8)
                    words = SpeakerAttribution.assign(words, turns: diar.turns)
                    metrics["diarizationSeconds"] = diar.seconds
                    metrics["maxWindowSeconds"] = diar.maxWindowSeconds
                    metrics["diarizationWindowSeconds"] = diar.windowSeconds
                    metrics["diarizationBaselineFootprintBytes"] = diar.baselineFootprintBytes
                    metrics["diarizationSampledPeakFootprintBytes"] = diar.sampledPeakFootprintBytes
                    metrics["diarizationExtraFootprintBytes"] = diar.extraFootprintBytes
                    metrics["diarizationClustersPerWindow"] = diar.clustersPerWindow
                    metrics["clusteringThreshold"] = threshold
                    metrics["peakPhysFootprintBytes"] = diar.processPeakPhysFootprintBytes
                } else {
                    try "".write(to: output.appendingPathComponent("\(stem).rttm"), atomically: true, encoding: .utf8)
                    if asrOnly { metrics["diarizationSkipped"] = true }
                }
                try writeJSON(words, to: output.appendingPathComponent("\(stem).words.json"))
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

    private static func referenceText(directory: URL, fixture: String) throws -> String {
        if fixture == "ls-1089-10m" {
            let url = directory.appendingPathComponent("\(fixture).ref.txt")
            guard FileManager.default.fileExists(atPath: url.path) else { throw SttBenchmarkError.missingFixture(url.path) }
            return try String(contentsOf: url, encoding: .utf8)
        }
        let suffix = fixture == "ami-es2004a-10m" ? "words.json" : "ref.json"
        let url = directory.appendingPathComponent("\(fixture).\(suffix)")
        guard FileManager.default.fileExists(atPath: url.path) else { throw SttBenchmarkError.missingFixture(url.path) }
        let entries = try JSONDecoder().decode([TimedWord].self, from: Data(contentsOf: url))
        return entries.map(\.text).joined(separator: " ")
    }

    private struct Recognition {
        let text: String
        let words: [TimedWord]
        let loadSeconds: Double
        let decodeSeconds: Double
        let peakPhysFootprintBytes: UInt64
        let sampledPeakPhysFootprintBytes: UInt64
        let speechSegments: Int
        let emptyVadSegments: Int
        let maxSpeechSegmentSeconds: Double
        let maxAsrWindowSeconds: Double
        let vadCoverageSeconds: Double
        let vadSegments: [[String: Any]]
        let asrWindows: [[String: Any]]
        let vadProcessingSeconds: Double
    }

    private static func recognize(samples: [Float], model: URL, threads: Int,
                                  vadCap: Float, hardSplit: Double,
                                  blankPenalty: Float, chunkPad: Double) throws -> Recognition {
        for file in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] {
            guard FileManager.default.fileExists(atPath: model.appendingPathComponent(file).path) else {
                throw SttBenchmarkError.missingFixture(model.appendingPathComponent(file).path)
            }
        }
        let sampler = try MemorySampler()
        let loadStart = CFAbsoluteTimeGetCurrent()
        let modelConfig = sherpaOnnxOfflineModelConfig(
            tokens: model.appendingPathComponent("tokens.txt").path,
            transducer: sherpaOnnxOfflineTransducerModelConfig(
                encoder: model.appendingPathComponent("encoder.int8.onnx").path,
                decoder: model.appendingPathComponent("decoder.int8.onnx").path,
                joiner: model.appendingPathComponent("joiner.int8.onnx").path),
            numThreads: threads, provider: "cpu", modelType: "nemo_transducer")
        var config = sherpaOnnxOfflineRecognizerConfig(featConfig: sherpaOnnxFeatureConfig(),
                                                       modelConfig: modelConfig, decodingMethod: "greedy_search",
                                                       blankPenalty: blankPenalty)
        let recognizer = SherpaOnnxOfflineRecognizer(config: &config)
        let loaded = CFAbsoluteTimeGetCurrent()
        let segmented = try speechChunks(samples: samples,
                                         model: model.deletingLastPathComponent().appendingPathComponent("silero_vad.onnx"),
                                         threads: threads, cap: vadCap, hardSplit: hardSplit)
        var words: [TimedWord] = []
        var windows: [[String: Any]] = []
        var wordsPerSegment = [Int](repeating: 0, count: segmented.vadSegments.count)
        let padSamples = Int((chunkPad * 16_000).rounded())
        let silence = [Float](repeating: 0, count: padSamples)
        for chunk in segmented.chunks {
            let input = padSamples == 0 ? chunk.samples : silence + chunk.samples + silence
            let result = recognizer.decode(samples: input)
            var tokens: [String] = []
            if result.count > 0 {
                guard let tokenPointers = result.result.pointee.tokens_arr else {
                    throw SttBenchmarkError.missingTokenData
                }
                for index in 0..<result.count {
                    guard let pointer = tokenPointers[index] else { throw SttBenchmarkError.missingTokenData }
                    tokens.append(String(cString: pointer))
                }
            }
            guard tokens.count == result.count else { throw SttBenchmarkError.missingTokenData }
            let decoded = try TokenWordAlignment.align(tokens: tokens, timestamps: result.timestamps,
                                                        durations: result.durations,
                                                        origin: Double(chunk.start - padSamples) / 16_000)
            let kept = decoded.filter { word in
                let middle = (word.start + word.end) * 8_000 // seconds to midpoint sample.
                return middle >= Double(chunk.ownedStart) && middle < Double(chunk.ownedEnd)
            }
            words += kept
            wordsPerSegment[chunk.sourceSegment] += kept.count
            windows.append(["start": Double(chunk.start) / 16_000,
                            "end": Double(chunk.end) / 16_000,
                            "ownedStart": Double(chunk.ownedStart) / 16_000,
                            "ownedEnd": Double(chunk.ownedEnd) / 16_000,
                            "sourceVadSegment": chunk.sourceSegment,
                            "decodedWords": decoded.count, "keptWords": kept.count])
        }
        let ended = CFAbsoluteTimeGetCurrent()
        let memory = try sampler.stop()
        let vadMetrics = segmented.vadSegments.enumerated().map { index, segment in
            ["start": Double(segment.start) / 16_000,
             "end": Double(segment.end) / 16_000,
             "decodedWords": wordsPerSegment[index],
             "rms": segment.rms,
             "sourceMaxSampleDifference": segment.sourceMaxSampleDifference] as [String: Any]
        }
        return Recognition(text: words.map(\.text).joined(separator: " "), words: words,
                           loadSeconds: loaded - loadStart + segmented.loadSeconds,
                           decodeSeconds: ended - loaded - segmented.loadSeconds,
                           peakPhysFootprintBytes: memory.lifetimePeak,
                           sampledPeakPhysFootprintBytes: memory.sampledPeak,
                           speechSegments: segmented.vadSegments.count,
                           emptyVadSegments: wordsPerSegment.filter { $0 == 0 }.count,
                           maxSpeechSegmentSeconds: Double(segmented.vadSegments.map { $0.end - $0.start }.max() ?? 0) / 16_000,
                           maxAsrWindowSeconds: Double(segmented.chunks.map { $0.end - $0.start }.max() ?? 0) / 16_000,
                           vadCoverageSeconds: Double(segmented.vadSegments.reduce(0) { $0 + $1.end - $1.start }) / 16_000,
                           vadSegments: vadMetrics, asrWindows: windows,
                           vadProcessingSeconds: segmented.processingSeconds)
    }

    private struct SpeechChunk {
        let start: Int
        let end: Int
        let ownedStart: Int
        let ownedEnd: Int
        let sourceSegment: Int
        let samples: [Float]
    }

    private struct SpeechRange {
        let start: Int
        let end: Int
        let rms: Double
        let sourceMaxSampleDifference: Double
    }

    private struct SpeechChunks {
        let chunks: [SpeechChunk]
        let vadSegments: [SpeechRange]
        let loadSeconds: Double
        let processingSeconds: Double
    }

    private static func speechChunks(samples: [Float], model: URL, threads: Int,
                                     cap: Float, hardSplit: Double) throws -> SpeechChunks {
        guard FileManager.default.fileExists(atPath: model.path) else {
            throw SttBenchmarkError.missingFixture(model.path)
        }
        let began = CFAbsoluteTimeGetCurrent()
        var config = sherpaOnnxVadModelConfig(
            sileroVad: sherpaOnnxSileroVadModelConfig(model: model.path,
                                                     minSilenceDuration: 0.4,
                                                     minSpeechDuration: 0.1,
                                                     maxSpeechDuration: cap),
            numThreads: threads)
        let vad = SherpaOnnxVoiceActivityDetectorWrapper(config: &config, buffer_size_in_seconds: 30)
        let loaded = CFAbsoluteTimeGetCurrent()
        var chunks: [SpeechChunk] = []
        var vadSegments: [SpeechRange] = []
        func drain() throws {
            while !vad.isEmpty() {
                let segment = vad.front()
                let sourceIndex = vadSegments.count
                let end = segment.start + segment.samples.count
                guard segment.start >= 0, end <= samples.count else {
                    throw SttBenchmarkError.invalidAudio("VAD segment outside source audio")
                }
                var squared = 0.0
                var maxDifference = 0.0
                for index in segment.samples.indices {
                    let value = Double(segment.samples[index])
                    squared += value * value
                    maxDifference = max(maxDifference,
                                        abs(value - Double(samples[segment.start + index])))
                }
                let rms = (squared / Double(max(1, segment.samples.count))).squareRoot()
                vadSegments.append(.init(start: segment.start, end: end,
                                         rms: rms, sourceMaxSampleDifference: maxDifference))
                let planned = hardSplit == 0
                    ? [AsrWindow(start: 0, end: segment.samples.count,
                                 ownedStart: 0, ownedEnd: segment.samples.count)]
                    : AsrWindowing.plan(samples: segment.samples, sampleRate: 16_000,
                                        maxSeconds: hardSplit)
                for part in planned {
                    chunks.append(.init(start: segment.start + part.start,
                                        end: segment.start + part.end,
                                        ownedStart: segment.start + part.ownedStart,
                                        ownedEnd: segment.start + part.ownedEnd,
                                        sourceSegment: sourceIndex,
                                        samples: Array(segment.samples[part.start..<part.end])))
                }
                vad.pop()
            }
        }
        for offset in stride(from: 0, to: samples.count, by: 512) {
            vad.acceptWaveform(samples: Array(samples[offset..<min(offset + 512, samples.count)]))
            try drain()
        }
        vad.flush()
        try drain()
        return SpeechChunks(chunks: chunks, vadSegments: vadSegments, loadSeconds: loaded - began,
                            processingSeconds: CFAbsoluteTimeGetCurrent() - loaded)
    }

    private struct Diarization {
        let rttm: String
        let seconds: Double
        let maxWindowSeconds: Double
        let windowSeconds: [Double]
        let baselineFootprintBytes: UInt64
        let sampledPeakFootprintBytes: UInt64
        let processPeakPhysFootprintBytes: UInt64
        let extraFootprintBytes: UInt64
        let clustersPerWindow: [Int]
        let turns: [SpeakerTurn]
    }

    private static func diarize(samples: [Float], model: URL, threads: Int, threshold: Float) throws -> Diarization {
        let seg = model.appendingPathComponent("model.int8.onnx").path
        let embedding = model.appendingPathComponent("3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx").path
        for path in [seg, embedding] where !FileManager.default.fileExists(atPath: path) {
            throw SttBenchmarkError.missingFixture(path)
        }
        guard let baseline = footprintSnapshot()?.current else { throw SttBenchmarkError.memoryProbeFailed }
        let sampler = try MemorySampler()
        var config = sherpaOnnxOfflineSpeakerDiarizationConfig(
            segmentation: sherpaOnnxOfflineSpeakerSegmentationModelConfig(
                pyannote: sherpaOnnxOfflineSpeakerSegmentationPyannoteModelConfig(model: seg), numThreads: threads),
            embedding: sherpaOnnxSpeakerEmbeddingExtractorConfig(model: embedding, numThreads: threads),
            clustering: sherpaOnnxFastClusteringConfig(threshold: threshold))
        let diarizer = SherpaOnnxOfflineSpeakerDiarizationWrapper(config: &config)
        let start = CFAbsoluteTimeGetCurrent()
        var maxWindow = 0.0
        var windowSeconds: [Double] = []
        var lines: [String] = []
        var attributedTurns: [SpeakerTurn] = []
        var clustersPerWindow: [Int] = []
        let window = 60 * 16_000
        for offset in stride(from: 0, to: samples.count, by: window) {
            let windowIndex = offset / window
            let began = CFAbsoluteTimeGetCurrent()
            let turns = diarizer.process(samples: Array(samples[offset..<min(offset + window, samples.count)]))
            let elapsed = CFAbsoluteTimeGetCurrent() - began
            maxWindow = max(maxWindow, elapsed)
            windowSeconds.append(elapsed)
            clustersPerWindow.append(Set(turns.map(\.speaker)).count)
            for turn in turns {
                let origin = Double(offset) / 16_000
                let speaker = "w\(windowIndex)_speaker_\(turn.speaker)"
                lines.append(String(format: "SPEAKER benchmark 1 %.3f %.3f <NA> <NA> %@ <NA> <NA>",
                                    origin + Double(turn.start), Double(turn.end - turn.start), speaker))
                attributedTurns.append(.init(start: origin + Double(turn.start), end: origin + Double(turn.end),
                                             speaker: speaker))
            }
        }
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        let memory = try sampler.stop()
        return Diarization(rttm: lines.joined(separator: "\n") + "\n",
                           seconds: elapsed, maxWindowSeconds: maxWindow, windowSeconds: windowSeconds,
                           baselineFootprintBytes: baseline,
                           sampledPeakFootprintBytes: memory.sampledPeak,
                           processPeakPhysFootprintBytes: memory.lifetimePeak,
                           extraFootprintBytes: memory.sampledPeak > baseline ? memory.sampledPeak - baseline : 0,
                           clustersPerWindow: clustersPerWindow, turns: attributedTurns)
    }

    private static func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }

    private struct FootprintSnapshot {
        let current: UInt64
        let lifetimePeak: UInt64
    }

    private final class MemorySampler {
        private let lock = NSLock()
        private let timer = DispatchSource.makeTimerSource(
            queue: DispatchQueue(label: "exo.stt.benchmark.memory", qos: .userInitiated))
        private var sampledPeak: UInt64
        private var lifetimePeak: UInt64
        private var failed = false

        init() throws {
            guard let initial = SttBenchmark.footprintSnapshot() else {
                throw SttBenchmarkError.memoryProbeFailed
            }
            sampledPeak = initial.current
            lifetimePeak = initial.lifetimePeak
            timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.sample() }
            timer.resume()
        }

        deinit { timer.cancel() }

        private func sample() {
            let value = SttBenchmark.footprintSnapshot()
            lock.lock()
            defer { lock.unlock() }
            guard let value else { failed = true; return }
            sampledPeak = max(sampledPeak, value.current)
            lifetimePeak = max(lifetimePeak, value.lifetimePeak)
        }

        func stop() throws -> (sampledPeak: UInt64, lifetimePeak: UInt64) {
            timer.cancel()
            sample()
            lock.lock()
            defer { lock.unlock() }
            guard !failed else { throw SttBenchmarkError.memoryProbeFailed }
            return (sampledPeak, lifetimePeak)
        }
    }

    private static func footprintSnapshot() -> FootprintSnapshot? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return FootprintSnapshot(current: info.phys_footprint,
                                 lifetimePeak: UInt64(max(0, info.ledger_phys_footprint_peak)))
    }
}
#endif
