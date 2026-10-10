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
        try library.appendJournal(id, ["e": "input", "t": wallMilliseconds(), "a": 0,
                                       "id": "synthetic", "name": "Synthetic sine", "kind": "built_in"])
        let openedAt = wallMilliseconds()
        try library.openFirstSegment(id, at: openedAt)
        let writer = try AacAdtsWriter(library: library, id: id, segmentOpenedAt: openedAt)
        writer.setGeneration(1)
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
            writer.enqueue(buffer, generation: 1)
        }
        let paused = try writer.closeForPause()
        try library.appendJournal(id, ["e": "intent", "t": paused.at, "a": paused.audioMs,
                                       "value": "paused", "by": "user"], fullSync: true)
        try library.appendJournal(id, ["e": "intent", "t": wallMilliseconds(), "a": paused.audioMs,
                                       "value": "recording", "by": "user"])
        try library.appendJournal(id, ["e": "avail", "t": wallMilliseconds(), "a": paused.audioMs,
                                       "value": "available", "reason": NSNull(), "gen": 2])
        try writer.reopen()
        writer.setGeneration(2)
        for batch in 12..<14 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096),
                  let channel = buffer.floatChannelData?[0] else { throw CaptureError.io("create sine buffer") }
            buffer.frameLength = 4096
            for frame in 0..<4096 {
                channel[frame] = 0.2 * sin(Float(2 * Double.pi * 440 * Double(batch * 4096 + frame) / 48_000))
            }
            writer.enqueue(buffer, generation: 2)
        }
        let stoppedAt = wallMilliseconds()
        let audioMs = try writer.finish(at: stoppedAt).audioMs
        guard audioMs > 0 else { throw CaptureError.noAudio }
        try library.appendJournal(id, ["e": "intent", "t": stoppedAt, "a": audioMs,
                                       "value": "stopped", "by": "user"])
        try library.appendJournal(id, ["e": "stop", "t": stoppedAt, "a": audioMs,
                                       "reason": "user"], fullSync: true)
        let segmentPath = library.segmentURL(id, index: 0)
        let adts = try Data(contentsOf: segmentPath)
        // Simulate a prior process leaving a stopped journal plus durable ADTS data.
        let recoveryID = UUID().uuidString.lowercased()
        let recoveryInfo = SessionInfo(id: recoveryID, source: "in_app", owner: nil,
                                       transitionGen: 0, options: CaptureOptions(), startedAt: openedAt)
        try library.startSession(recoveryInfo)
        try library.openFirstSegment(recoveryID, at: openedAt)
        let recoveredSegment = library.segmentURL(recoveryID, index: 0)
        let recoveredHandle = try FileHandle(forWritingTo: recoveredSegment)
        try recoveredHandle.write(contentsOf: adts)
        try recoveredHandle.close()
        try library.checkpoint(recoveryID, segment: 0, bytes: Int64(adts.count), audioMs: paused.audioMs,
                               intent: "recording", availability: "available", fullSync: true)
        try library.appendJournal(recoveryID, ["e": "stop", "t": stoppedAt, "a": paused.audioMs,
                                               "reason": "user"], fullSync: true)
        let recoveredJournal = try JournalRecovery(events: library.readJournal(recoveryID))
        let recoverySidecar = SidecarFactory.v2(session: recoveryInfo, durationMs: paused.audioMs,
                                                wallMs: recoveredJournal.wallMs,
                                                pausedMs: recoveredJournal.pausedMs,
                                                spans: recoveredJournal.spans, input: nil,
                                                recovered: true,
                                                endedUnexpectedly: recoveredJournal.endedUnexpectedly,
                                                lastHeartbeatAt: recoveredJournal.lastHeartbeatAt)
        let recoveryItem = try library.commit(recoveryID, sidecar: recoverySidecar) { staged in
            try RecordingFinalizer.mux(segments: RecordingFinalizer.segments(in: library.sessionURL(recoveryID)),
                                       expectedAudioMs: paused.audioMs, to: staged)
        }
        let recoveryOK = recoveryItem["recovered"] as? Bool == true &&
            !FileManager.default.fileExists(atPath: library.sessionURL(recoveryID).path)
        let segmentTrack = AVURLAsset(url: segmentPath).tracks(withMediaType: .audio).first
        let segmentDescription = segmentTrack?.formatDescriptions.first
        let segmentAsbd = segmentDescription.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0 as! CMAudioFormatDescription)?.pointee }
        let journal = try library.readJournal(id)
        let pausedIndex = journal.firstIndex { $0["e"] as? String == "intent" && $0["value"] as? String == "paused" }
        let resumedIndex = journal.firstIndex { $0["e"] as? String == "intent" && $0["value"] as? String == "recording" }
        let stoppedIndex = journal.firstIndex { $0["e"] as? String == "intent" && $0["value"] as? String == "stopped" }
        let pauseValid: Bool = {
            guard let pausedIndex, let resumedIndex, let stoppedIndex,
                  pausedIndex > 0, resumedIndex + 2 < journal.count, stoppedIndex > 0,
                  stoppedIndex + 1 < journal.count else { return false }
            let finalBeforePause = journal[pausedIndex - 1]
            let finalBeforeStop = journal[stoppedIndex - 1]
            return finalBeforePause["e"] as? String == "hb" &&
                finalBeforePause["intent"] as? String == "recording" &&
                finalBeforePause["availability"] as? String == "available" &&
                finalBeforePause["t"] as? Int64 == journal[pausedIndex]["t"] as? Int64 &&
                finalBeforePause["a"] as? Int64 == journal[pausedIndex]["a"] as? Int64 &&
                journal[resumedIndex + 1]["e"] as? String == "avail" &&
                journal[resumedIndex + 2]["e"] as? String == "segment" &&
                finalBeforeStop["e"] as? String == "hb" &&
                finalBeforeStop["intent"] as? String == "recording" &&
                finalBeforeStop["availability"] as? String == "available" &&
                finalBeforeStop["t"] as? Int64 == journal[stoppedIndex]["t"] as? Int64 &&
                finalBeforeStop["a"] as? Int64 == journal[stoppedIndex]["a"] as? Int64 &&
                journal[stoppedIndex + 1]["e"] as? String == "stop"
        }()
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
        let orphanID = UUID().uuidString.lowercased()
        let orphanURL = library.audioURL(orphanID)
        try FileManager.default.copyItem(at: library.audioURL(id), to: orphanURL)
        try library.probeLegacy(orphanID) {
            let orphanAsset = AVURLAsset(url: orphanURL)
            let seconds = CMTimeGetSeconds(orphanAsset.duration)
            guard !orphanAsset.tracks(withMediaType: .audio).isEmpty, seconds.isFinite, seconds >= 0.5 else {
                return nil
            }
            let session = SessionInfo(id: orphanID, source: "in_app", owner: nil, transitionGen: 0,
                                      options: CaptureOptions(), startedAt: wallMilliseconds())
            var item = SidecarFactory.v2(session: session, durationMs: Int64(seconds * 1000),
                                         wallMs: Int64(seconds * 1000), pausedMs: 0, spans: [], input: nil,
                                         recovered: true, endedUnexpectedly: false, lastHeartbeatAt: nil)
            item["legacyImport"] = true; item["ownerUnknown"] = true
            item["sizeBytes"] = (try? orphanURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return item
        }
        let orphanSidecar = try library.readSidecar(orphanID)
        let orphanHeld = orphanSidecar["ownerUnknown"] as? Bool == true &&
            orphanSidecar["legacyImport"] as? Bool == true
        let sync = library.syncMetrics()
        return ["committed": item["version"] as? Int == 2,
                "recovery": recoveryOK ? "ok" : "failed",
                "durationMs": audioMs,
                "probedDurationMs": Int64(CMTimeGetSeconds(asset.duration) * 1000),
                "sampleRate": Int(asbd?.mSampleRate ?? 0),
                "segmentRate": Int(segmentAsbd?.mSampleRate ?? 0),
                "adtsFrequencyIndex": adts.count > 2 ? Int((adts[2] >> 2) & 0x0f) : -1,
                "channels": Int(asbd?.mChannelsPerFrame ?? 0),
                "legacyHeld": legacyHeld,
                "orphanHeld": orphanHeld,
                "fullSyncMeanMs": sync["F_FULLFSYNC"]?.meanMs as Any? ?? NSNull(),
                "barrierSyncMeanMs": sync["F_BARRIERFSYNC"]?.meanMs as Any? ?? NSNull(),
                "fallbackSyncMeanMs": sync["fsync_fallback"]?.meanMs as Any? ?? NSNull(),
                "pauseSequenceValid": pauseValid,
                "sessionsGone": !FileManager.default.fileExists(atPath: library.sessionURL(id).path)]
    }
}
