#if DEBUG && targetEnvironment(simulator)
import AVFoundation
import CaptureCore
import Foundation

/// Debug-simulator-only PCM source. The simulator's microphone is the host Mac's microphone, so
/// touching `AVAudioEngine.inputNode` there records the room. This source never creates an engine
/// or touches any input node: it delivers silent 48 kHz mono buffers at real-time cadence through
/// the same tap handler the engine path uses. With `EXO_SIM_AUDIO_INPUT=file:<name>` the buffers
/// instead loop an embedded test clip (see `SimulatorAudioClips`), converted to 48 kHz mono float.
final class SimulatorSilentInput {
    static let inputID = "exo-sim-silence"
    static let inputName = "Simulator silence (debug)"
    static let environmentKey = "EXO_SIM_AUDIO_INPUT"
    static let frames: AVAudioFrameCount = 1024
    static let sampleRate = 48_000.0

    enum Clip: String, CaseIterable {
        case speech, sweep
        var base64: String {
            switch self {
            case .speech: return SimulatorAudioClips.speechBase64
            case .sweep: return SimulatorAudioClips.sweepBase64
            }
        }
    }

    enum Mode: Equatable { case silence, host, file(Clip) }

    static func identity(for mode: Mode) -> (id: String, name: String) {
        if case .file(let clip) = mode { return ("exo-sim-file-\(clip.rawValue)", "Simulator file: \(clip.rawValue) (debug)") }
        return (inputID, inputName)
    }

    /// Unset or `silence` selects the synthetic source; `file:<speech|sweep>` loops an embedded clip;
    /// `host` opts back into the Mac microphone. Any other value is rejected so a typo cannot select
    /// a mic by accident.
    static func mode(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> Mode {
        switch environment[environmentKey] {
        case nil, "silence": return .silence
        case "host": return .host
        case let value? where value.hasPrefix("file:"):
            let name = String(value.dropFirst("file:".count))
            guard let clip = Clip(rawValue: name) else {
                let known = Clip.allCases.map(\.rawValue).joined(separator: ", ")
                throw CaptureError.io("\(environmentKey)=\(value): unknown clip \"\(name)\" (use file:<\(known)>)")
            }
            return .file(clip)
        case let other?:
            throw CaptureError.io("\(environmentKey)=\(other) is not supported (use unset/silence, file:<name> or host)")
        }
    }

    static var format: AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    }

    private let queue = DispatchQueue(label: "xyz.tinycloud.exo.sim-silence", qos: .userInitiated)
    private let format = SimulatorSilentInput.format
    private var timer: DispatchSourceTimer?
    private var startedAt: TimeInterval = 0
    private var deliveredFrames: AVAudioFramePosition = 0
    private let handler: AVAudioNodeTapBlock
    private let samples: [Float]?
    private let manual: Bool
    private var manualRunning = false

    var isRunning: Bool { manual ? manualRunning : timer != nil }

    /// `manual` sources have no timer: buffers are delivered only by `deliver(buffers:)`, so engine
    /// tests control exactly when taps arrive and no wall-clock thread races their injected clocks.
    init(manual: Bool = false, samples: [Float]? = nil, handler: @escaping AVAudioNodeTapBlock) {
        self.manual = manual
        self.samples = samples
        self.handler = handler
    }

    func start() {
        deliveredFrames = 0
        if manual { manualRunning = true; return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        startedAt = ProcessInfo.processInfo.systemUptime
        let period = Double(Self.frames) / Self.sampleRate
        timer.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer
        timer.resume()
    }

    /// Returns after any in-flight delivery has finished; no buffer is delivered afterwards.
    func stop() {
        manualRunning = false
        timer?.cancel()
        timer = nil
        queue.sync {}
    }

    /// Manual sources only: synchronously delivers `buffers` silent buffers; none once stopped.
    func deliver(buffers: Int) {
        precondition(manual, "deliver(buffers:) is for manual sources")
        guard manualRunning else { return }
        for _ in 0..<buffers { deliverNext() }
    }

    private func deliverNext() {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: Self.frames) else {
            preconditionFailure("allocate simulator silence buffer")
        }
        buffer.frameLength = Self.frames
        let out = buffer.floatChannelData![0]
        if let samples, !samples.isEmpty {
            var at = Int(deliveredFrames % AVAudioFramePosition(samples.count))
            for i in 0..<Int(Self.frames) {
                out[i] = samples[at]
                at += 1
                if at == samples.count { at = 0 }
            }
        } else {
            memset(out, 0, Int(Self.frames) * MemoryLayout<Float>.size)
        }
        handler(buffer, AVAudioTime(sampleTime: deliveredFrames, atRate: Self.sampleRate))
        deliveredFrames += AVAudioFramePosition(Self.frames)
    }

    private func tick() {
        // Deliver whatever real time says is due, so a late timer catches up instead of dropping audio.
        let due = AVAudioFramePosition((ProcessInfo.processInfo.systemUptime - startedAt) * Self.sampleRate)
        var delivered = 0
        while deliveredFrames + AVAudioFramePosition(Self.frames) <= due, delivered < 64 {
            deliverNext()
            delivered += 1
        }
    }
}

extension SimulatorSilentInput {
    private static let decodeLock = NSLock()
    nonisolated(unsafe) private static var decoded: [Clip: [Float]] = [:]

    /// The clip as 48 kHz mono float samples. Decoded once, from the embedded WAV, via a temporary file.
    static func samples(for clip: Clip) throws -> [Float] {
        decodeLock.lock(); defer { decodeLock.unlock() }
        if let cached = decoded[clip] { return cached }
        guard let data = Data(base64Encoded: clip.base64, options: .ignoreUnknownCharacters), !data.isEmpty else {
            throw CaptureError.io("simulator clip \(clip.rawValue) is not valid base64")
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("exo-sim-clip-\(clip.rawValue)-\(UUID().uuidString).wav")
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let converted = try convert(file: AVAudioFile(forReading: url), name: clip.rawValue)
        decoded[clip] = converted
        return converted
    }

    static func convert(file: AVAudioFile, name: String) throws -> [Float] {
        let input = file.processingFormat
        let length = AVAudioFrameCount(file.length)
        guard length > 0, let source = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: length) else {
            throw CaptureError.io("simulator clip \(name) is empty")
        }
        try file.read(into: source)
        guard let converter = AVAudioConverter(from: input, to: format) else {
            throw CaptureError.io("simulator clip \(name): cannot convert \(input) to 48 kHz mono")
        }
        let capacity = AVAudioFrameCount(Double(length) * sampleRate / input.sampleRate) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw CaptureError.io("simulator clip \(name): allocate output")
        }
        var supplied = false
        var failure: NSError?
        let status = converter.convert(to: output, error: &failure) { _, outStatus in
            if supplied { outStatus.pointee = .endOfStream; return nil }
            supplied = true
            outStatus.pointee = .haveData
            return source
        }
        guard status != .error, failure == nil else {
            throw CaptureError.io("simulator clip \(name): conversion failed: \(failure.map(String.init(describing:)) ?? "unknown")")
        }
        let expected = Double(length) * sampleRate / input.sampleRate
        guard abs(Double(output.frameLength) - expected) <= expected * 0.02 + 64 else {
            throw CaptureError.io("simulator clip \(name): converted \(output.frameLength) frames, expected about \(Int(expected))")
        }
        return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
    }
}
#endif
