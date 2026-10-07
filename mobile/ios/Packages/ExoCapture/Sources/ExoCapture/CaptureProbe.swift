import AVFoundation
import CaptureCore
import Foundation

/// Debug smoke: synthetic PCM takes the production converter, ADTS writer, muxer and library path.
public enum CaptureProbe {
    public static func run() throws -> [String: Any] {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-capture-smoke-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try RecordingLibrary(root: root)
        let id = UUID().uuidString.lowercased()
        let info = SessionInfo(id: id, source: "in_app", owner: nil, transitionGen: 0,
                               options: CaptureOptions(), startedAt: wallMilliseconds())
        try library.startSession(info)
        try library.appendJournal(id, ["e": "avail", "t": wallMilliseconds(), "a": 0,
                                       "value": "available", "reason": NSNull(), "gen": 1])
        try library.openFirstSegment(id)
        let writer = try AacAdtsWriter(library: library, id: id)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1) else {
            throw CaptureError.io("create sine format")
        }
        for batch in 0..<12 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096),
                  let channel = buffer.floatChannelData?[0] else { throw CaptureError.io("create sine buffer") }
            buffer.frameLength = 4096
            for frame in 0..<4096 {
                channel[frame] = 0.2 * sin(Float(2 * Double.pi * 440 * Double(batch * 4096 + frame) / 48_000))
            }
            writer.enqueue(buffer)
        }
        let paused = try writer.closeForPause()
        try library.appendJournal(id, ["e": "intent", "t": paused.at, "a": paused.audioMs,
                                       "value": "paused", "by": "user"], fullSync: true)
        try library.appendJournal(id, ["e": "intent", "t": wallMilliseconds(), "a": paused.audioMs,
                                       "value": "recording", "by": "user"])
        try library.appendJournal(id, ["e": "avail", "t": wallMilliseconds(), "a": paused.audioMs,
                                       "value": "available", "reason": NSNull(), "gen": 2])
        try writer.reopen()
        for batch in 12..<14 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096),
                  let channel = buffer.floatChannelData?[0] else { throw CaptureError.io("create sine buffer") }
            buffer.frameLength = 4096
            for frame in 0..<4096 {
                channel[frame] = 0.2 * sin(Float(2 * Double.pi * 440 * Double(batch * 4096 + frame) / 48_000))
            }
            writer.enqueue(buffer)
        }
        let audioMs = try writer.finish().audioMs
        guard audioMs > 0 else { throw CaptureError.noAudio }
        let stoppedAt = wallMilliseconds()
        try library.appendJournal(id, ["e": "intent", "t": stoppedAt, "a": audioMs,
                                       "value": "stopped", "by": "user"])
        try library.appendJournal(id, ["e": "stop", "t": stoppedAt, "a": audioMs,
                                       "reason": "user"], fullSync: true)
        let segmentPath = library.segmentURL(id, index: 0)
        let adts = try Data(contentsOf: segmentPath)
        let segmentTrack = AVURLAsset(url: segmentPath).tracks(withMediaType: .audio).first
        let segmentDescription = segmentTrack?.formatDescriptions.first
        let segmentAsbd = segmentDescription.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0 as! CMAudioFormatDescription)?.pointee }
        let journal = try library.readJournal(id)
        let pauseSequence = journal.map { $0["e"] as? String }
        let pauseValid = pauseSequence.contains("intent") && pauseSequence.filter { $0 == "segment" }.count == 2 &&
            journal.last(where: { $0["e"] as? String == "hb" })?["intent"] as? String == "recording"
        let sidecar = SidecarFactory.v2(session: info, durationMs: audioMs,
                                        wallMs: wallMilliseconds() - info.startedAt,
                                        pausedMs: 0, spans: [], input: ["id": "synthetic",
                                                                       "name": "Synthetic sine", "kind": "built_in"],
                                        recovered: false, endedUnexpectedly: false,
                                        lastHeartbeatAt: try library.readJournal(id).last(where: {
                                            $0["e"] as? String == "hb"
                                        })?["t"] as? Int64)
        let item = try library.commit(id, sidecar: sidecar) { staged in
            try RecordingFinalizer.mux(segments: RecordingFinalizer.segments(in: library.sessionURL(id)),
                                       expectedAudioMs: audioMs, to: staged)
        }
        let asset = AVURLAsset(url: library.audioURL(id))
        let track = asset.tracks(withMediaType: .audio).first
        let formatDescription = track?.formatDescriptions.first
        let asbd = formatDescription.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0 as! CMAudioFormatDescription)?.pointee }
        // A v1 pair remains listed and gains ownerUnknown only in the returned shape.
        let legacyId = UUID().uuidString.lowercased()
        try FileManager.default.copyItem(at: library.audioURL(id), to: library.audioURL(legacyId))
        try JSONSerialization.data(withJSONObject: ["id": legacyId, "durationMs": audioMs])
            .write(to: library.sidecarURL(legacyId))
        let legacyHeld = try library.listCommitted().contains {
            $0["id"] as? String == legacyId && $0["ownerUnknown"] as? Bool == true
        }
        let sync = library.syncMetrics()
        return ["committed": item["version"] as? Int == 2,
                "durationMs": audioMs,
                "probedDurationMs": Int64(CMTimeGetSeconds(asset.duration) * 1000),
                "sampleRate": Int(asbd?.mSampleRate ?? 0),
                "segmentRate": Int(segmentAsbd?.mSampleRate ?? 0),
                "adtsFrequencyIndex": adts.count > 2 ? Int((adts[2] >> 2) & 0x0f) : -1,
                "channels": Int(asbd?.mChannelsPerFrame ?? 0),
                "legacyHeld": legacyHeld,
                "fullSyncMeanMs": sync["F_FULLFSYNC"]?.meanMs as Any? ?? NSNull(),
                "barrierSyncMeanMs": sync["F_BARRIERFSYNC"]?.meanMs as Any? ?? NSNull(),
                "fallbackSyncMeanMs": sync["fsync_fallback"]?.meanMs as Any? ?? NSNull(),
                "pauseSequenceValid": pauseValid,
                "sessionsGone": !FileManager.default.fileExists(atPath: library.sessionURL(id).path)]
    }
}
