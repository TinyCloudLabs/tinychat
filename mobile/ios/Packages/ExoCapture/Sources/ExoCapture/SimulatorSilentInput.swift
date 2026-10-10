#if DEBUG && targetEnvironment(simulator)
import AVFoundation
import CaptureCore
import Foundation

/// Debug-simulator-only PCM source. The simulator's microphone is the host Mac's microphone, so
/// touching `AVAudioEngine.inputNode` there records the room. This source never creates an engine
/// or touches any input node: it delivers silent 48 kHz mono buffers at real-time cadence through
/// the same tap handler the engine path uses.
final class SimulatorSilentInput {
    static let inputName = "Simulator silence (debug)"
    static let environmentKey = "EXO_SIM_AUDIO_INPUT"
    static let frames: AVAudioFrameCount = 1024
    static let sampleRate = 48_000.0

    enum Mode { case silence, host }

    /// Unset or `silence` selects the synthetic source; `host` opts back into the Mac microphone.
    /// Any other value is rejected so a typo cannot select a mic by accident.
    static func mode(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> Mode {
        switch environment[environmentKey] {
        case nil, "silence": return .silence
        case "host": return .host
        case let other?:
            throw CaptureError.io("\(environmentKey)=\(other) is not supported (use unset/silence or host)")
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

    var isRunning: Bool { timer != nil }

    init(handler: @escaping AVAudioNodeTapBlock) { self.handler = handler }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        startedAt = ProcessInfo.processInfo.systemUptime
        deliveredFrames = 0
        let period = Double(Self.frames) / Self.sampleRate
        timer.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer
        timer.resume()
    }

    /// Returns after any in-flight delivery has finished; no buffer is delivered afterwards.
    func stop() {
        timer?.cancel()
        timer = nil
        queue.sync {}
    }

    private func tick() {
        // Deliver whatever real time says is due, so a late timer catches up instead of dropping audio.
        let due = AVAudioFramePosition((ProcessInfo.processInfo.systemUptime - startedAt) * Self.sampleRate)
        var delivered = 0
        while deliveredFrames + AVAudioFramePosition(Self.frames) <= due, delivered < 64 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: Self.frames) else {
                preconditionFailure("allocate simulator silence buffer")
            }
            buffer.frameLength = Self.frames
            memset(buffer.floatChannelData![0], 0, Int(Self.frames) * MemoryLayout<Float>.size)
            handler(buffer, AVAudioTime(sampleTime: deliveredFrames, atRate: Self.sampleRate))
            deliveredFrames += AVAudioFramePosition(Self.frames)
            delivered += 1
        }
    }
}
#endif
