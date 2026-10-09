import CBZip2
import Foundation

enum Bzip2Error: Error {
    case initFailed(Int32)
    case decompressFailed(Int32)
    case ioFailed
}

/// Streams a `.bz2` file to a plain file, never holding the whole (de)compressed content in
/// memory. The small model pack's archive decompresses to roughly 140 MB; this writes it to disk
/// in ~1 MB chunks instead of allocating that much at once.
enum Bzip2 {
    static func decompress(inputURL: URL, outputURL: URL) throws {
        guard let input = InputStream(url: inputURL) else { throw Bzip2Error.ioFailed }
        input.open()
        defer { input.close() }
        guard FileManager.default.createFile(atPath: outputURL.path, contents: nil),
              let output = OutputStream(url: outputURL, append: false) else { throw Bzip2Error.ioFailed }
        output.open()
        defer { output.close() }

        var stream = bz_stream()
        let initResult = BZ2_bzDecompressInit(&stream, 0, 0)
        guard initResult == BZ_OK else { throw Bzip2Error.initFailed(initResult) }
        defer { BZ2_bzDecompressEnd(&stream) }

        let inCapacity = 1 << 16
        let outCapacity = 1 << 20
        let inBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: inCapacity)
        let outBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: outCapacity)
        defer { inBuffer.deallocate(); outBuffer.deallocate() }

        var streamEnded = false
        while !streamEnded {
            let bytesRead = input.read(inBuffer, maxLength: inCapacity)
            if bytesRead < 0 { throw Bzip2Error.ioFailed }
            if bytesRead == 0 { break } // EOF: a well-formed single-stream .bz2 reaches BZ_STREAM_END first.
            stream.avail_in = UInt32(bytesRead)
            inBuffer.withMemoryRebound(to: Int8.self, capacity: inCapacity) { stream.next_in = $0 }

            while stream.avail_in > 0 && !streamEnded {
                stream.avail_out = UInt32(outCapacity)
                outBuffer.withMemoryRebound(to: Int8.self, capacity: outCapacity) { stream.next_out = $0 }
                let result = BZ2_bzDecompress(&stream)
                guard result == BZ_OK || result == BZ_STREAM_END else { throw Bzip2Error.decompressFailed(result) }
                let produced = outCapacity - Int(stream.avail_out)
                if produced > 0 {
                    let written = output.write(outBuffer, maxLength: produced)
                    guard written == produced else { throw Bzip2Error.ioFailed }
                }
                if result == BZ_STREAM_END { streamEnded = true }
            }
        }
        guard streamEnded else { throw Bzip2Error.decompressFailed(-1) }
    }
}
