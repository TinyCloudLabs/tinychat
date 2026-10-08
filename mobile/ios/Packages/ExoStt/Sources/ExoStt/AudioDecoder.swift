import AVFoundation
import Foundation

/// Decodes a committed note's `.m4a` to 16 kHz mono Float32 (plan §2.5 step 1), the format
/// sherpa-onnx's VAD and recognizer both expect. The whole note is decoded into memory at once
/// (as the T7 benchmark already does for its fixtures): correct for the recordings this slice was
/// verified against, but a multi-hour note can use several hundred MB doing this; T23 moves to a
/// blockwise decode to bound that.
enum AudioDecoder {
    enum Error: Swift.Error { case openFailed, converterFailed, readFailed }

    static func decode16kMono(_ url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        guard file.length > 0 else { return [] }
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        guard let converter = AVAudioConverter(from: file.processingFormat, to: target) else { throw Error.converterFailed }
        let readChunkFrames: AVAudioFrameCount = 48_000 * 10 // ~10 s of source audio per read.
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: readChunkFrames) else {
            throw Error.converterFailed
        }
        var result: [Float] = []
        result.reserveCapacity(Int(Double(file.length) * target.sampleRate / file.processingFormat.sampleRate))
        var reachedEndOfFile = false
        // One AVAudioConverterInputBlock call per source read; loop `convert` until it has drained
        // that read (status `.inputRanDry`) before asking for the next chunk of the file.
        while !reachedEndOfFile {
            var suppliedThisRead = false
            conversionLoop: while true {
                var error: NSError?
                let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
                    if suppliedThisRead {
                        outStatus.pointee = .noDataNow
                        return nil
                    }
                    guard let inputBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: readChunkFrames) else {
                        outStatus.pointee = .noDataNow
                        return nil
                    }
                    do {
                        try file.read(into: inputBuffer, frameCount: readChunkFrames)
                    } catch {
                        outStatus.pointee = .noDataNow
                        return nil
                    }
                    suppliedThisRead = true
                    if inputBuffer.frameLength == 0 {
                        reachedEndOfFile = true
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    outStatus.pointee = .haveData
                    return inputBuffer
                }
                if let error { throw error }
                if let channel = outputBuffer.floatChannelData?[0], outputBuffer.frameLength > 0 {
                    result.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(outputBuffer.frameLength)))
                }
                switch status {
                case .haveData: continue conversionLoop
                case .inputRanDry: break conversionLoop
                case .endOfStream: reachedEndOfFile = true; break conversionLoop
                case .error: throw Error.readFailed
                @unknown default: break conversionLoop
                }
            }
        }
        return result
    }
}
