import AVFoundation
import AudioToolbox
import CaptureCore
import Foundation

/// The audio tap copies PCM into a bounded queue. Conversion and all file writes happen on
/// the writer queue, never on Core Audio's real-time callback.
final class AacAdtsWriter {
    private let library: RecordingLibrary
    private let clock: CaptureClock
    private let id: String
    private let queue = DispatchQueue(label: "xyz.tinycloud.exo.capture.writer")
    private let queueLock = NSLock()
    private var pendingFrames = 0
    private var activeGeneration = 0
    private var accepting = true
    private var stalled = false
    private var staleFrames = 0
    private var stalledFrames = 0
    private var converter: AVAudioConverter?
    private var handle: FileHandle?
    private var segment = 0
    private var segmentBytes: Int64 = 0
    private var audioFrames: Int64 = 0
    private var segmentStartFrames: Int64 = 0
    private var heartbeat: HeartbeatSchedule
    private var lastFullSync = Date()
    private var stopped = false
    var onLevel: ((Double, Double) -> Void)?
    var onFailure: ((Error) -> Void)?
    var onFrames: ((Int64) -> Void)?
    var onStall: ((Bool, Int) -> Void)?
    var onStale: ((Int) -> Void)?

    init(library: RecordingLibrary, id: String, segmentOpenedAt: Int64,
         clock: CaptureClock = SystemCaptureClock()) throws {
        self.library = library; self.id = id; self.clock = clock
        self.heartbeat = HeartbeatSchedule(segmentOpenedAt: segmentOpenedAt)
        self.handle = try FileHandle(forWritingTo: library.segmentURL(id, index: 0))
    }

    init(parkedLibrary library: RecordingLibrary, id: String, lastSegment: Int,
         audioFrames: Int64, clock: CaptureClock) {
        self.library = library; self.id = id; self.clock = clock
        self.segment = lastSegment; self.audioFrames = audioFrames
        self.segmentStartFrames = audioFrames
        self.heartbeat = HeartbeatSchedule(segmentOpenedAt: clock.nowMilliseconds())
        self.handle = nil
        self.accepting = false
    }

    var audioMs: Int64 { queue.sync { audioFrames * 1000 / 48_000 } }
    var rejectedStaleFrames: Int {
        queueLock.lock(); defer { queueLock.unlock() }
        return staleFrames
    }
    var droppedStallFrames: Int {
        queueLock.lock(); defer { queueLock.unlock() }
        return stalledFrames
    }

    func setGeneration(_ generation: Int) {
        queueLock.lock(); activeGeneration = generation; accepting = true; queueLock.unlock()
    }

    func enqueue(_ input: AVAudioPCMBuffer, generation: Int) {
        let frames = Int(input.frameLength)
        queueLock.lock()
        guard accepting && generation == activeGeneration else {
            staleFrames += frames
            let lost = staleFrames
            queueLock.unlock()
            onStale?(lost)
            return
        }
        if pendingFrames + frames > Int(input.format.sampleRate * 10) {
            stalledFrames += frames
            let dropped = stalledFrames
            let first = !stalled
            stalled = true
            queueLock.unlock()
            if first { onStall?(true, dropped) }
            return
        }
        pendingFrames += frames
        queueLock.unlock()

        guard let copy = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: input.frameLength) else {
            queueLock.lock(); pendingFrames -= frames; queueLock.unlock()
            onFailure?(CaptureError.io("allocate PCM buffer"))
            return
        }
        copy.frameLength = input.frameLength
        let srcBuffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input.audioBufferList))
        let dstBuffers = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<min(srcBuffers.count, dstBuffers.count) {
            if let src = srcBuffers[index].mData, let dst = dstBuffers[index].mData {
                memcpy(dst, src, Int(srcBuffers[index].mDataByteSize))
            }
        }
        if let channels = input.floatChannelData, frames > 0 {
            var sum = 0.0, peak = 0.0
            for channel in 0..<Int(input.format.channelCount) {
                let samples = channels[channel]
                for index in 0..<frames {
                    let value = Double(samples[index])
                    sum += value * value
                    peak = max(peak, abs(value))
                }
            }
            onLevel?(min(1, sqrt(sum / Double(frames * Int(input.format.channelCount)))), min(1, peak))
        }
        queue.async { [weak self] in
            guard let self else { return }
            defer {
                self.queueLock.lock()
                self.pendingFrames -= frames
                let recovered = self.stalled && self.pendingFrames <= Int(copy.format.sampleRate / 2)
                if recovered { self.stalled = false }
                let dropped = self.stalledFrames
                self.queueLock.unlock()
                if recovered { self.onStall?(false, dropped) }
            }
            do { try self.encode(copy, generation: generation) }
            catch { self.onFailure?(error) }
        }
    }

    private func encode(_ pcm: AVAudioPCMBuffer, generation: Int) throws {
        queueLock.lock()
        let valid = generation == activeGeneration
        if !valid { staleFrames += Int(pcm.frameLength) }
        let lost = staleFrames
        queueLock.unlock()
        guard valid, !stopped, let handle else { onStale?(lost); return }
        if converter == nil {
            guard let output = AVAudioFormat(settings: [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
            ]), let encoder = AVAudioConverter(from: pcm.format, to: output) else {
                throw CaptureError.io("create 48 kHz AAC encoder")
            }
            converter = encoder
        }
        guard let converter, let format = converter.outputFormat as AVAudioFormat? else { return }
        var supplied = false
        for _ in 0..<32 {
            let compressed = AVAudioCompressedBuffer(format: format, packetCapacity: 16,
                                                     maximumPacketSize: 8192)
            var error: NSError?
            let result = converter.convert(to: compressed, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return pcm
            }
            if let error { throw error }
            try writePackets(compressed, to: handle)
            if result == .inputRanDry || result == .endOfStream { break }
        }
        let now = Date()
        let shouldRoll = audioFrames - segmentStartFrames >= 60 * 48_000
        if heartbeat.periodicDue(at: clock.nowMilliseconds(), closing: shouldRoll) {
            try library.checkpoint(id, segment: segment, bytes: segmentBytes,
                                   audioMs: audioFrames * 1000 / 48_000,
                                   intent: "recording", availability: "available")
            onFrames?(audioFrames * 1000 / 48_000)
        }
        if now.timeIntervalSince(lastFullSync) >= 10 {
            try library.fullSyncSegment(id, index: segment)
            lastFullSync = now
        }
        if shouldRoll {
            try library.checkpoint(id, segment: segment, bytes: segmentBytes,
                                   audioMs: audioFrames * 1000 / 48_000,
                                   intent: "recording", availability: "available", fullSync: true)
            onFrames?(audioFrames * 1000 / 48_000)
            try handle.close()
            segment += 1
            let openedAt = clock.nowMilliseconds()
            let next = try library.rollSegment(id, next: segment,
                                               audioMs: audioFrames * 1000 / 48_000, at: openedAt)
            self.handle = try FileHandle(forWritingTo: next)
            segmentBytes = 0
            segmentStartFrames = audioFrames
            heartbeat = HeartbeatSchedule(segmentOpenedAt: openedAt)
            lastFullSync = now
        }
    }

    private func writePackets(_ compressed: AVAudioCompressedBuffer, to handle: FileHandle) throws {
        guard compressed.packetCount > 0 else { return }
        let bytes = UnsafeRawBufferPointer(start: compressed.data, count: Int(compressed.byteLength))
        let packets = compressed.packetDescriptions
        var cursor = 0
        for index in 0..<Int(compressed.packetCount) {
            let size = packets == nil ? Int(compressed.byteLength) : Int(packets![index].mDataByteSize)
            guard size > 0, cursor + size <= bytes.count else { throw CaptureError.io("bad AAC packet") }
            var frame = Data(try ADTS.header(payloadBytes: size))
            frame.append(contentsOf: bytes[cursor..<(cursor + size)])
            try library.appendSegment(frame, to: handle)
            segmentBytes += Int64(frame.count)
            audioFrames += 1024
            cursor += size
        }
    }

    private func drainEncoder(to handle: FileHandle) throws {
        guard let converter else { return }
        for _ in 0..<32 {
            let compressed = AVAudioCompressedBuffer(format: converter.outputFormat, packetCapacity: 16,
                                                     maximumPacketSize: 8192)
            var error: NSError?
            let result = converter.convert(to: compressed, error: &error) { _, status in
                status.pointee = .endOfStream
                return nil
            }
            if let error { throw error }
            try writePackets(compressed, to: handle)
            if result == .endOfStream || compressed.packetCount == 0 { break }
        }
        self.converter = nil
    }

    func closeForPause() throws -> (audioMs: Int64, at: Int64) {
        queueLock.lock(); accepting = false; queueLock.unlock()
        return try queue.sync {
            guard handle != nil else { return (audioFrames * 1000 / 48_000, clock.nowMilliseconds()) }
            try drainEncoder(to: handle!)
            let at = clock.nowMilliseconds()
            try library.checkpoint(id, segment: segment, bytes: segmentBytes,
                                   audioMs: audioFrames * 1000 / 48_000,
                                   intent: "recording", availability: "available", fullSync: true, at: at)
            onFrames?(audioFrames * 1000 / 48_000)
            try handle?.close(); handle = nil
            return (audioFrames * 1000 / 48_000, at)
        }
    }

    func reopen() throws {
        try queue.sync {
            let nextIndex = segment + 1
            let openedAt = clock.nowMilliseconds()
            let next = try library.rollSegment(id, next: nextIndex,
                                               audioMs: audioFrames * 1000 / 48_000, at: openedAt)
            segment = nextIndex
            handle = try FileHandle(forWritingTo: next)
            segmentBytes = 0
            segmentStartFrames = audioFrames
            converter = nil
            heartbeat = HeartbeatSchedule(segmentOpenedAt: openedAt)
            lastFullSync = Date()
        }
    }

    func finish(at stoppedAt: Int64) throws -> (audioMs: Int64, heartbeatAt: Int64?) {
        queueLock.lock(); accepting = false; queueLock.unlock()
        return try queue.sync {
            stopped = true
            var heartbeatAt: Int64?
            if handle != nil {
                try drainEncoder(to: handle!)
                try library.checkpoint(id, segment: segment, bytes: segmentBytes,
                                       audioMs: audioFrames * 1000 / 48_000,
                                       intent: "recording", availability: "available", fullSync: true, at: stoppedAt)
                heartbeatAt = stoppedAt
            }
            try handle?.close(); handle = nil
            return (audioFrames * 1000 / 48_000, heartbeatAt)
        }
    }
}
