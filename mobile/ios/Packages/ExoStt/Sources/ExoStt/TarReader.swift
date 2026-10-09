import Foundation

enum TarReaderError: Error {
    case malformedHeader
    case truncated
}

/// A minimal USTAR/GNU-tar reader: only what extracting named files out of a known-good archive
/// needs (no symlinks, no long-name extensions, no PAX headers -- the small model pack's archive
/// uses plain file and directory entries).
enum TarReader {
    private static let blockSize = 512

    /// Copies each entry named in `wanted` to `destination(name)`, streaming through the tar file
    /// without holding any entry's full contents in memory.
    static func extract(tarURL: URL, wanted: Set<String>, destination: (String) -> URL) throws -> Set<String> {
        guard let handle = FileHandle(forReadingAtPath: tarURL.path) else { throw TarReaderError.truncated }
        defer { handle.closeFile() }
        var extracted: Set<String> = []
        while true {
            let header = handle.readData(ofLength: blockSize)
            if header.count < blockSize { break }
            if header.allSatisfy({ $0 == 0 }) { break } // end-of-archive marker
            var name = asciiString(header, offset: 0, length: 100)
            if name.hasPrefix("./") { name.removeFirst(2) }
            let sizeField = asciiString(header, offset: 124, length: 12)
            guard let size = UInt64(sizeField.trimmingCharacters(in: .whitespacesAndNewlines), radix: 8) else {
                throw TarReaderError.malformedHeader
            }
            let typeflag = header[156]
            let isFile = typeflag == 0 || typeflag == UInt8(ascii: "0")
            let paddedSize = Int((size + UInt64(blockSize) - 1) / UInt64(blockSize)) * blockSize

            if isFile, wanted.contains(name) {
                let outputURL = destination(name)
                FileManager.default.createFile(atPath: outputURL.path, contents: nil)
                guard let output = FileHandle(forWritingAtPath: outputURL.path) else { throw TarReaderError.truncated }
                defer { output.closeFile() }
                var remaining = size
                while remaining > 0 {
                    let chunkSize = Int(min(remaining, UInt64(1 << 20)))
                    let chunk = handle.readData(ofLength: chunkSize)
                    guard !chunk.isEmpty else { throw TarReaderError.truncated }
                    output.write(chunk)
                    remaining -= UInt64(chunk.count)
                }
                let skip = paddedSize - Int(size)
                if skip > 0 { _ = handle.readData(ofLength: skip) }
                extracted.insert(name)
            } else {
                // Not wanted (or a directory, which has no data blocks): skip straight past it.
                if paddedSize > 0 {
                    let current = handle.offsetInFile
                    handle.seek(toFileOffset: current + UInt64(paddedSize))
                }
            }
            if extracted.count == wanted.count { break }
        }
        return extracted
    }

    private static func asciiString(_ data: Data, offset: Int, length: Int) -> String {
        let slice = data.subdata(in: offset..<(offset + length))
        let bytes = slice.prefix { $0 != 0 }
        return String(decoding: bytes, as: UTF8.self)
    }
}
