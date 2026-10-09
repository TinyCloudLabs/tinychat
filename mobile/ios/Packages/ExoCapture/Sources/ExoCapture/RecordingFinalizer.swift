import AVFoundation
import CaptureCore
import Foundation
import OSLog

public enum RecordingFinalizer {
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "capture.finalizer")
    /// AVFoundation understands ADTS AAC as an asset. Export to MPEG-4 is performed outside
    /// RecordingLibrary's lock; the library publishes the resulting file only after revalidation.
    public static func mux(segments: [URL], expectedAudioMs: Int64, to output: URL,
                           waitTimeout: TimeInterval = 30) throws {
        guard !segments.isEmpty else { throw CaptureError.noAudio }
        // A single ADTS stream avoids charging a separate decoder priming gap to every
        // segment after Pause or an interruption.
        let combined = output.deletingPathExtension().appendingPathExtension("combined.aac")
        guard FileManager.default.createFile(atPath: combined.path, contents: nil) else {
            throw CaptureError.io("create combined AAC stream")
        }
        defer { try? FileManager.default.removeItem(at: combined) }
        let combinedHandle = try FileHandle(forWritingTo: combined)
        var completeFrames = 0
        for segment in segments {
            let data = try Data(contentsOf: segment)
            let prefix = ADTS.completePrefix(data)
            guard prefix.frames > 0 else { continue }
            try combinedHandle.write(contentsOf: data.prefix(prefix.bytes))
            completeFrames += prefix.frames
        }
        try combinedHandle.close()
        guard completeFrames > 0 else { throw CaptureError.noAudio }
        let source = AVURLAsset(url: combined)
        guard let track = source.tracks(withMediaType: .audio).first else { throw CaptureError.noAudio }
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
        guard reader.startReading(), writer.startWriting() else {
            throw reader.error ?? writer.error ?? CaptureError.io("start AAC remux")
        }
        var completed = false
        defer {
            if !completed {
                reader.cancelReading()
                writer.cancelWriting()
            }
        }
        writer.startSession(atSourceTime: .zero)
        log.notice("mux stage=append_start frames=\(completeFrames) segments=\(segments.count)")
        // A stalled AVAssetWriter must release Stop; RecordingLibrary keeps the source segments.
        guard waitTimeout > 0 else {
            log.error("mux stage=ready_wait outcome=timeout")
            throw CaptureError.finalizationTimedOut("ready_wait")
        }
        var samples = 0
        while let sample = readerOutput.copyNextSampleBuffer() {
            let waitStarted = ProcessInfo.processInfo.systemUptime
            var loggedWait = false
            while !writerInput.isReadyForMoreMediaData {
                if !loggedWait {
                    log.notice("mux stage=ready_wait sample=\(samples)")
                    loggedWait = true
                }
                guard writer.status == .writing else { throw writer.error ?? CaptureError.io("AAC remux stopped") }
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
        log.notice("mux stage=mark_finished samples=\(samples)")
        writerInput.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        log.notice("mux stage=finish_writing outcome=start")
        writer.finishWriting { done.signal() }
        guard done.wait(timeout: .now() + waitTimeout) == .success else {
            log.error("mux stage=finish_writing outcome=timeout")
            throw CaptureError.finalizationTimedOut("finish_writing")
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
