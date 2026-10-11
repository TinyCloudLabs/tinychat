import AVFoundation
import CaptureCore
import Foundation
import OSLog

public enum RecordingFinalizer {
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "capture.finalizer")
    /// Progress the mux worker reports (a stage reached, a sample appended). The watchdog reads
    /// it together with the staged file's size; the worker learns of abandonment through it.
    final class MuxProgress {
        private let lock = NSLock()
        private var count = 0
        private var cancelled = false

        func tick() throws {
            lock.lock(); defer { lock.unlock() }
            guard !cancelled else { throw CaptureError.cancelled }
            count += 1
        }

        func checkCancelled() throws {
            lock.lock(); defer { lock.unlock() }
            guard !cancelled else { throw CaptureError.cancelled }
        }

        func cancel() { lock.lock(); cancelled = true; lock.unlock() }

        var ticks: Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    private final class MuxOutcome {
        private let lock = NSLock()
        private var result: Result<Void, Error>?
        private var abandoned = false

        func complete(_ value: Result<Void, Error>) -> Bool {
            lock.lock(); defer { lock.unlock() }
            result = value
            return abandoned
        }

        func abandon() {
            lock.lock(); abandoned = true; lock.unlock()
        }

        func isAbandoned() -> Bool {
            lock.lock(); defer { lock.unlock() }
            return abandoned
        }

        func value() -> Result<Void, Error>? {
            lock.lock(); defer { lock.unlock() }
            return result
        }
    }
    // The real AVFoundation objects remain in use. Tests can hold either wait open
    // and make cancellation block, without relying on a simulator's encoder timing.
    struct WaitSeam {
        var beforeMuxWorker: (() -> Void)?
        var isReady: (AVAssetWriterInput) -> Bool = { $0.isReadyForMoreMediaData }
        var cancelWriting: (AVAssetWriter) -> Void = { $0.cancelWriting() }
        /// Replaces the AVFoundation worker so tests can model a slow, progressing or stalled mux.
        var workerOverride: ((_ output: URL, _ progress: MuxProgress) throws -> Void)?
    }

    /// One rule for Stop, launch recovery and "Try again": a mux fails only when it stops making
    /// progress, or (as a last resort) exceeds a ceiling scaled to the note's duration.
    struct Config {
        var waitTimeout: TimeInterval = MuxWatchdog.defaultStallSeconds
        var stallTimeout: TimeInterval = MuxWatchdog.defaultStallSeconds
        var ceilingOverride: TimeInterval?
        var seam = WaitSeam()
    }

    private static func fileSize(_ url: URL) -> Int64 {
        Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }

    /// Waits for the writer to finish; `waitTimeout` is a no-progress timeout when `progress`
    /// is given, so a slow flush that keeps growing the file is not cut off.
    static func awaitFinishWriting(waitTimeout: TimeInterval, progress: (() -> Int64)? = nil,
                                   finish: (@escaping () -> Void) -> Void) throws {
        let done = DispatchSemaphore(value: 0)
        finish { done.signal() }
        var last = progress?() ?? 0
        var deadline = ProcessInfo.processInfo.systemUptime + waitTimeout
        while true {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if done.wait(timeout: .now() + max(0, min(remaining, 0.25))) == .success { return }
            if let progress {
                let current = progress()
                if current != last { last = current; deadline = ProcessInfo.processInfo.systemUptime + waitTimeout }
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                log.error("mux stage=finish_writing outcome=timeout")
                throw CaptureError.finalizationTimedOut("finish_writing")
            }
        }
    }
    /// AVFoundation understands ADTS AAC as an asset. Export to MPEG-4 is performed outside
    /// RecordingLibrary's lock; the library publishes the resulting file only after revalidation.
    public static func mux(segments: [URL], expectedAudioMs: Int64, to output: URL,
                           waitTimeout: TimeInterval = MuxWatchdog.defaultStallSeconds) throws {
        var config = Config()
        config.waitTimeout = waitTimeout
        try mux(segments: segments, expectedAudioMs: expectedAudioMs, to: output, config: config)
    }

    static func mux(segments: [URL], expectedAudioMs: Int64, to output: URL, config: Config) throws {
        guard !segments.isEmpty else { throw CaptureError.noAudio }
        guard config.waitTimeout > 0, config.stallTimeout > 0 else { throw CaptureError.invalidArgument }
        let ceiling = config.ceilingOverride ?? MuxWatchdog.ceilingSeconds(forAudioMs: expectedAudioMs)
        guard ceiling > 0 else { throw CaptureError.invalidArgument }
        // AVFoundation can block synchronously in track lookup, startWriting, sample copying or
        // append, so the mux runs off the caller's thread under a progress watchdog. A slow host
        // never fails a mux that keeps appending samples or growing the file. A late worker is
        // cancelled and only discards its staged output; RecordingLibrary never publishes it
        // after this call throws.
        let finished = DispatchSemaphore(value: 0)
        let outcome = MuxOutcome()
        let progress = MuxProgress()
        let seam = config.seam
        DispatchQueue.global(qos: .userInitiated).async {
            seam.beforeMuxWorker?()
            if outcome.isAbandoned() {
                finished.signal()
                return
            }
            let result = Result {
                if let override = seam.workerOverride {
                    try override(output, progress)
                } else {
                    try muxWorker(segments: segments, expectedAudioMs: expectedAudioMs, to: output,
                                  waitTimeout: config.waitTimeout, seam: seam, progress: progress)
                }
            }
            if outcome.complete(result) { try? FileManager.default.removeItem(at: output) }
            finished.signal()
        }
        let startedAt = ProcessInfo.processInfo.systemUptime
        var watchdog = MuxWatchdog(startedAt: startedAt, stallSeconds: config.stallTimeout,
                                   ceilingSeconds: ceiling)
        let poll = min(0.5, max(0.01, config.stallTimeout / 4))
        while finished.wait(timeout: .now() + poll) != .success {
            let ticks = progress.ticks
            let bytes = fileSize(output)
            switch watchdog.observe(ticks: ticks, bytes: bytes, now: ProcessInfo.processInfo.systemUptime) {
            case .running: continue
            case .stalled:
                outcome.abandon(); progress.cancel()
                log.error("mux stage=operation outcome=stalled noProgressSeconds=\(config.stallTimeout) ticks=\(ticks) bytes=\(bytes)")
                throw CaptureError.finalizationTimedOut("mux")
            case .ceilingReached:
                outcome.abandon(); progress.cancel()
                log.error("mux stage=operation outcome=ceiling ceilingSeconds=\(ceiling) ticks=\(ticks) bytes=\(bytes)")
                throw CaptureError.finalizationTimedOut("mux_ceiling")
            }
        }
        guard let result = outcome.value() else { throw CaptureError.io("mux finished without result") }
        try result.get()
    }

    private static func muxWorker(segments: [URL], expectedAudioMs: Int64, to output: URL,
                                  waitTimeout: TimeInterval, seam: WaitSeam,
                                  progress: MuxProgress) throws {
        // A single ADTS stream avoids charging a separate decoder priming gap to every
        // segment after Pause or an interruption.
        let combined = output.deletingPathExtension().appendingPathExtension("combined.aac")
        guard FileManager.default.createFile(atPath: combined.path, contents: nil) else {
            throw CaptureError.io("create combined AAC stream")
        }
        defer { try? FileManager.default.removeItem(at: combined) }
        let combinedHandle = try FileHandle(forWritingTo: combined)
        var completeFrames = 0
        try progress.tick()
        for segment in segments {
            try progress.tick()
            let data = try Data(contentsOf: segment)
            let prefix = ADTS.completePrefix(data)
            guard prefix.frames > 0 else { continue }
            try combinedHandle.write(contentsOf: data.prefix(prefix.bytes))
            completeFrames += prefix.frames
        }
        try combinedHandle.close()
        guard completeFrames > 0 else { throw CaptureError.noAudio }
        try progress.tick()
        let source = AVURLAsset(url: combined)
        log.notice("mux stage=track_lookup outcome=start frames=\(completeFrames)")
        guard let track = source.tracks(withMediaType: .audio).first else { throw CaptureError.noAudio }
        log.notice("mux stage=track_lookup outcome=completed")
        try progress.tick()
        let reader = try AVAssetReader(asset: source)
        let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ])
        guard reader.canAdd(readerOutput) else { throw CaptureError.io("AAC reader cannot read composition") }
        reader.add(readerOutput)
        let writer = try AVAssetWriter(outputURL: output, fileType: .m4a)
        let writerInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
        ])
        writerInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(writerInput) else { throw CaptureError.io("MPEG-4 writer cannot accept AAC") }
        writer.add(writerInput)
        log.notice("mux stage=reader_start outcome=start")
        guard reader.startReading() else { throw reader.error ?? CaptureError.io("start AAC reader") }
        log.notice("mux stage=reader_start outcome=completed")
        log.notice("mux stage=writer_start outcome=start")
        guard writer.startWriting() else {
            throw reader.error ?? writer.error ?? CaptureError.io("start AAC remux")
        }
        log.notice("mux stage=writer_start outcome=completed")
        try progress.tick()
        var completed = false
        defer {
            if !completed {
                // AVAssetWriter.cancelWriting may itself block forever. Neither Stop nor
                // recovery waits for this best-effort cleanup; the staged path is removed
                // by RecordingLibrary.commit on failure, while segments remain intact.
                DispatchQueue.global(qos: .utility).async {
                    seam.cancelWriting(writer)
                    reader.cancelReading()
                }
            }
        }
        writer.startSession(atSourceTime: .zero)
        log.notice("mux stage=append_start frames=\(completeFrames) segments=\(segments.count)")
        // A stalled AVAssetWriter must release Stop; RecordingLibrary keeps the source segments.
        var samples = 0
        var readyWaits = 0
        while let sample = readerOutput.copyNextSampleBuffer() {
            try progress.tick()
            var waitStarted = ProcessInfo.processInfo.systemUptime
            var waitBytes = fileSize(output)
            var loggedWait = false
            while !seam.isReady(writerInput) {
                readyWaits += 1
                if !loggedWait && ProcessInfo.processInfo.systemUptime - waitStarted >= 1 {
                    log.notice("mux stage=ready_wait sample=\(samples) elapsedMs=\(Int((ProcessInfo.processInfo.systemUptime - waitStarted) * 1000))")
                    loggedWait = true
                }
                guard writer.status == .writing else { throw writer.error ?? CaptureError.io("AAC remux stopped") }
                try progress.checkCancelled()
                let size = fileSize(output)
                if size != waitBytes { waitBytes = size; waitStarted = ProcessInfo.processInfo.systemUptime }
                guard ProcessInfo.processInfo.systemUptime - waitStarted < waitTimeout else {
                    log.error("mux stage=ready_wait outcome=timeout sample=\(samples)")
                    throw CaptureError.finalizationTimedOut("ready_wait")
                }
                Thread.sleep(forTimeInterval: 0.005)
            }
            guard writerInput.append(sample) else { throw writer.error ?? CaptureError.io("append AAC packet") }
            samples += 1
        }
        guard reader.status == .completed else { throw reader.error ?? CaptureError.io("read AAC packets") }
        writer.endSession(atSourceTime: CMTime(value: expectedAudioMs, timescale: 1000))
        log.notice("mux stage=mark_finished samples=\(samples) readyWaits=\(readyWaits)")
        writerInput.markAsFinished()
        log.notice("mux stage=finish_writing outcome=start")
        try progress.tick()
        try awaitFinishWriting(waitTimeout: waitTimeout, progress: { fileSize(output) }) {
            writer.finishWriting(completionHandler: $0)
        }
        guard writer.status == .completed else { throw writer.error ?? CaptureError.io("finish MPEG-4") }
        completed = true
        log.notice("mux stage=finish_writing outcome=completed samples=\(samples)")
    }

    public static func segments(in folder: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "aac" && $0.lastPathComponent.hasPrefix("seg-") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
