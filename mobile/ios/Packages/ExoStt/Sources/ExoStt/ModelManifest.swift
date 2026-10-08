import Foundation

/// One file inside a model (or the VAD model, which has one file).
public struct ModelFile: Equatable, Sendable {
    public let name: String
    public let url: URL
    public let bytes: Int64
    public let sha256: String
}

/// A downloadable unit `OnDeviceStt.status()` reports on (plan §2.9). `parakeet-tdt-110m-en-int8`
/// and `diarization` are reported for shape parity with the full contract but have no
/// `ModelManifest` entry in this slice (§ below): downloading the 110M pack needs extracting a
/// `.tar.bz2` release asset, which this slice does not implement (TC-836 report, deviations).
public enum ModelManifest {
    public static let parakeetFull = "parakeet-tdt-0.6b-v3-int8"
    public static let parakeetSmall = "parakeet-tdt-110m-en-int8"
    public static let sileroVad = "silero-vad"
    public static let diarization = "diarization"

    /// Every model this build can actually download. Keyed by the TS `SttModelId`. Revision
    /// `2bda32ec70b097a55adaa07d9a7173915b43cc78` and the sha256 values are pinned by T7's
    /// `mobile/stt-fixtures.lock`; the Parakeet files come from sherpa-onnx's Hugging Face export,
    /// Silero VAD from a sherpa-onnx GitHub release (mobile/docs/stt-bench-ios.md).
    public static let downloadable: [String: [ModelFile]] = [
        parakeetFull: {
            let base = URL(string: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78")!
            return [
                ModelFile(name: "encoder.int8.onnx", url: base.appendingPathComponent("encoder.int8.onnx"),
                          bytes: 652_184_281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
                ModelFile(name: "decoder.int8.onnx", url: base.appendingPathComponent("decoder.int8.onnx"),
                          bytes: 11_845_275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
                ModelFile(name: "joiner.int8.onnx", url: base.appendingPathComponent("joiner.int8.onnx"),
                          bytes: 6_355_277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
                ModelFile(name: "tokens.txt", url: base.appendingPathComponent("tokens.txt"),
                          bytes: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
            ]
        }(),
        sileroVad: [
            ModelFile(name: "silero_vad.onnx",
                      url: URL(string: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx")!,
                      bytes: 643_854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"),
        ],
    ]

    /// Reported totals for every model id in the TS contract, including the two this build
    /// cannot download (their total is still shown; `ModelDownloads` fails them visibly).
    public static func totalBytes(_ id: String) -> Int64 {
        switch id {
        case parakeetFull: return 670_478_772
        case parakeetSmall: return 136_490_421
        case sileroVad: return 643_854
        case diarization: return 31_137_484
        default: return 0
        }
    }

    public static let allIds = [parakeetFull, parakeetSmall, sileroVad, diarization]

    /// The primary ASR model for a RAM tier (plan §2.9; T13 checks the threshold against a real
    /// 6 GB device).
    public static func primaryModel(physicalMemoryBytes: UInt64) -> String {
        physicalMemoryBytes >= 6_000_000_000 ? parakeetFull : parakeetSmall
    }
}
