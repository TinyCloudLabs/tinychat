import Foundation

#if EXO_STT_BENCH && os(macOS)
import ExoStt

@main
enum SttBenchMac {
    static func main() throws {
        guard CommandLine.arguments.count >= 2 else {
            fputs("usage: SttBenchMac <fixture-directory> [threads, e.g. 4,2]\n", stderr)
            exit(2)
        }
        let requested = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "4,2"
        let threads = requested.split(separator: ",").compactMap { Int($0) }
        let result = try SttBenchmark.run(directory: URL(fileURLWithPath: CommandLine.arguments[1]),
                                          threads: threads)
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
}
#else
@main
enum SttBenchMac {
    static func main() {
        fputs("SttBenchMac requires a macOS EXO_STT_BENCH build\n", stderr)
        exit(2)
    }
}
#endif
