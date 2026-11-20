// Transcribes one recording with Parakeet TDT v3 the way TinyCloud One's Soniqo path does, outside the app:
// each channel on its own (a stereo recording: channel 0 is Me, the microphone; channel 1 is Them, this Mac's
// audio), cut into 29.5 s windows with no overlap, a window shorter than 20 s padded with zeros to 20 s, the
// microphone's quiet windows skipped, language "en". Prints each window's text and time, the model load time
// and the real-time factor.
//
// Sources of the numbers (anarlog @864ddc1): crates/listener2-core/src/batch/simple/local.rs (29.5 s windows,
// the 0.0008 microphone RMS floor) and crates/transcribe-soniqo/swift-lib/src/lib.swift (the repository, the
// 20 s padding, the language hint).

import AVFoundation
import AudioCommon
import CoreML
import Foundation
import ParakeetASR

@main
struct ParakeetCheck {
  static let repository = "aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s"
  static let sampleRate = 16_000
  static let windowSamples = 16_000 * 59 / 2
  static let minimumSamples = 16_000 * 20
  static let microphoneMinimumRMS = 0.0008

  static func main() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let path = arguments.first else {
      fail("usage: parakeet-check <recording.wav|.mp3|.m4a> [language, default en]")
    }
    let language = arguments.count > 1 ? arguments[1] : "en"
    let url = URL(fileURLWithPath: path)

    let channels: [[Float]]
    let stereo: Bool
    do {
      stereo = try AVAudioFile(forReading: url).processingFormat.channelCount >= 2
      let both = try AudioFileLoader.loadStereo(url: url, targetSampleRate: sampleRate)
      channels = stereo ? both : [both[0]]
    } catch {
      fail("cannot read \(path): \(error.localizedDescription)")
    }
    let recordingSeconds = Double(channels[0].count) / Double(sampleRate)
    print("file: \(url.lastPathComponent), \(stereo ? "stereo" : "mono"), \(seconds(recordingSeconds)), language \(language)")

    let cache: URL
    do {
      cache = try HuggingFaceDownloader.getCacheDirectory(for: repository)
    } catch {
      fail("no cache folder: \(error.localizedDescription)")
    }
    let cached = FileManager.default.fileExists(
      atPath: cache.appendingPathComponent("encoder.mlmodelc/model.mil").path)
    print("model: \(repository)")
    print("cache: \(cache.path)\(cached ? "" : " (not there yet: downloading about 641 MB)")")

    let loadStart = Date()
    let model: ParakeetASRModel
    do {
      model = try await ParakeetASRModel.fromPretrained(
        modelId: repository, offlineMode: cached, progressHandler: LoadProgress().report)
    } catch {
      fail("model load failed: \(error.localizedDescription)")
    }
    let loadSeconds = Date().timeIntervalSince(loadStart)
    print("model load: \(seconds(loadSeconds)) (encoder on \(describe(model.encoderComputeUnits)))")

    var transcribing = 0.0
    var failures = 0
    for (index, samples) in channels.enumerated() {
      print("")
      print(stereo ? (index == 0 ? "== Me (channel 0, microphone)" : "== Them (channel 1, this Mac's audio)") : "== mono")
      var start = 0
      while start < samples.count {
        let end = min(samples.count, start + windowSamples)
        var window = Array(samples[start..<end])
        let span = "[\(clock(start))-\(clock(end))]"
        let energy = window.reduce(0.0) { sum, sample in sum + Double(sample) * Double(sample) }
        let rms = (energy / Double(window.count)).squareRoot()
        start = end
        if stereo && index == 0 && rms < microphoneMinimumRMS {
          print("\(span) skipped: quiet microphone (rms \(String(format: "%.5f", rms)))")
          continue
        }
        if window.count < minimumSamples {
          window += [Float](repeating: 0, count: minimumSamples - window.count)
        }
        let windowStart = Date()
        do {
          let text = try autoreleasepool {
            try model.transcribeAudio(window, sampleRate: sampleRate, language: language)
          }
          let elapsed = Date().timeIntervalSince(windowStart)
          transcribing += elapsed
          let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
          print("\(span) \(seconds(elapsed)): \(trimmed.isEmpty ? "(no text)" : trimmed)")
        } catch {
          failures += 1
          transcribing += Date().timeIntervalSince(windowStart)
          print("\(span) FAILED: \(error.localizedDescription)")
        }
      }
    }

    print("")
    print("recording: \(seconds(recordingSeconds)) x \(channels.count) channel(s)")
    print("model load: \(seconds(loadSeconds)); transcription: \(seconds(transcribing))")
    print("real-time factor (transcription / recording): \(String(format: "%.3f", transcribing / recordingSeconds))")
    print("real-time factor with the model load: \(String(format: "%.3f", (transcribing + loadSeconds) / recordingSeconds))")
    if failures > 0 {
      print("failed windows: \(failures)")
      exit(1)
    }
  }

  static func clock(_ sample: Int) -> String {
    let tenths = sample * 10 / sampleRate
    return String(format: "%ld:%02ld.%ld", tenths / 600, tenths / 10 % 60, tenths % 10)
  }

  static func seconds(_ value: Double) -> String {
    String(format: "%.2f s", value)
  }

  static func describe(_ units: MLComputeUnits) -> String {
    switch units {
    case .cpuOnly: return "CPU only"
    case .cpuAndGPU: return "CPU and GPU"
    case .cpuAndNeuralEngine: return "CPU and Neural Engine"
    case .all: return "all units"
    @unknown default: return "unknown units"
    }
  }

  static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}

/// Prints the download and load progress in 10 % steps. The loader may call it from any thread.
final class LoadProgress: @unchecked Sendable {
  private let lock = NSLock()
  private var last = -1

  func report(_ fraction: Double, _ status: String) {
    let step = Int(max(0, min(1, fraction)) * 10)
    lock.lock()
    defer { lock.unlock() }
    guard step != last else { return }
    last = step
    print("  \(step * 10)% \(status)")
  }
}
