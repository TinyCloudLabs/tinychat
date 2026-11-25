// Splits one channel of a recording into speakers with pyannote Community-1 (Core ML), outside the app.
// It prints only times, speaker numbers, counts, stage times and memory: no text, no names, no file name,
// so its output is safe to share.
//
// Long audio runs in windows (default 600 s). Each window is diarized on its own; then the speakers of all
// windows are joined, closest voice summaries first (cosine distance between the windows' speaker centroids),
// while the distance is below the threshold. Two speakers of one window are never joined. With --max, joining
// goes on past the threshold until at most that many speakers are left.

import AVFoundation
import AudioCommon
import Community1
import CoreML
import Foundation

@main
struct DiarizeCheck {
  static let usage = """
    usage: diarize-check <file> --channel 0|1 [--max N] [--min N] [--window SECONDS|0] \
    [--units cpu|ane|all] [--limit SECONDS] [--join DISTANCE]
    """
  static let sampleRate = 16_000

  struct Options {
    var path = ""
    var channel = -1
    var minimum = 1
    var maximum: Int?
    var window = 600.0
    var units = "cpu"
    var limit: Double?
    var join = 0.5
  }

  /// One speaker of one window, with its voice summary and how long it spoke.
  struct Voice {
    let window: Int
    let embedding: [Double]
    var seconds: Double
  }

  struct Turn {
    var start: Double
    var end: Double
    var voice: Int
    let window: Int
  }

  static func main() async {
    let started = Date()
    let options = parse(Array(CommandLine.arguments.dropFirst()))
    let computeUnits: MLComputeUnits =
      options.units == "ane" ? .cpuAndNeuralEngine : options.units == "all" ? .all : .cpuOnly

    // Read one channel at 16 kHz.
    let readStart = Date()
    let audio: [Float]
    let channelCount: Int
    do {
      let read = try readChannel(URL(fileURLWithPath: options.path), channel: options.channel, limit: options.limit)
      channelCount = read.channels
      audio = AudioFileLoader.resample(read.samples, from: read.rate, to: sampleRate)
    } catch {
      fail("cannot read the file: \(error.localizedDescription)")
    }
    let audioSeconds = Double(audio.count) / Double(sampleRate)
    guard audioSeconds > 0 else { fail("the channel is empty") }
    print("audio: channel \(options.channel) of \(channelCount), \(fixed(audioSeconds, 1)) s")
    let windowText = options.window > 0 ? fixed(options.window, 0) + " s" : "whole file"
    let maximumText = options.maximum.map { String($0) } ?? "none"
    print("settings: window \(windowText), units \(options.units), speakers min \(options.minimum) max \(maximumText), "
      + "join threshold \(fixed(options.join, 2))")
    if let override = ProcessInfo.processInfo.environment[CoreMLComputeUnitsResolver.envKey] {
      print("note: \(CoreMLComputeUnitsResolver.envKey)=\(override) overrides --units")
    }
    print("stage read audio: \(fixed(Date().timeIntervalSince(readStart), 2)) s (peak memory so far \(peakMemoryMB()) MB)")

    // Load the model, downloading it on the first run.
    let loadStart = Date()
    let pipeline: Community1DiarizationPipeline
    do {
      let cache = try HuggingFaceDownloader.getCacheDirectory(for: Community1DiarizationPipeline.defaultModelId)
      let cached = ["config.json", "plda.safetensors", "segmentation.mlmodelc/model.mil", "embedding.mlmodelc/model.mil"]
        .allSatisfy { FileManager.default.fileExists(atPath: cache.appendingPathComponent($0).path) }
      if !cached { print("downloading the model (about 34 MB)") }
      pipeline = try await Community1DiarizationPipeline.fromPretrained(offlineMode: cached, computeUnits: computeUnits)
    } catch {
      fail("model load failed: \(error.localizedDescription)")
    }
    print("stage load model: \(fixed(Date().timeIntervalSince(loadStart), 2)) s")

    // Diarize each window.
    let bounds = Community1SpeakerBounds(minimum: options.minimum, maximum: options.maximum)
    let windows = windowRanges(count: audio.count, size: Int(options.window * Double(sampleRate)))
    var voices: [Voice] = []
    var turns: [Turn] = []
    var diarizing = 0.0
    for (index, range) in windows.enumerated() {
      let windowStart = Date()
      let result: DiarizationResult
      do {
        result = try autoreleasepool {
          try pipeline.diarize(audio: Array(audio[range]), sampleRate: sampleRate, speakerBounds: bounds)
        }
      } catch {
        fail("window \(index + 1) failed: \(error.localizedDescription)")
      }
      let elapsed = Date().timeIntervalSince(windowStart)
      diarizing += elapsed
      let offset = Double(range.lowerBound) / Double(sampleRate)
      let windowEnd = Double(range.upperBound) / Double(sampleRate)
      let first = voices.count
      for speaker in 0..<result.numSpeakers {
        let embedding = speaker < result.speakerEmbeddings.count ? result.speakerEmbeddings[speaker] : []
        voices.append(Voice(window: index, embedding: embedding.map(Double.init), seconds: 0))
      }
      for segment in result.segments where segment.speakerId < result.numSpeakers {
        let start = offset + Double(segment.startTime)
        let end = min(windowEnd, offset + Double(segment.endTime))
        guard end > start else { continue }
        voices[first + segment.speakerId].seconds += end - start
        turns.append(Turn(start: start, end: end, voice: first + segment.speakerId, window: index))
      }
      print("stage window \(index + 1)/\(windows.count) [\(clock(offset))-\(clock(windowEnd))]: "
        + "\(result.numSpeakers) speakers, \(fixed(elapsed, 2)) s")
    }

    // Join the windows' speakers.
    let joinStart = Date()
    let joined = join(voices, threshold: options.join, maximum: options.maximum)
    let speakerOf = numberByFirstSpeech(turns: turns, cluster: joined.cluster)
    let merged = mergeAcrossWindows(turns.map { (original: Turn) -> Turn in
      var turn = original
      turn.voice = speakerOf[joined.cluster[turn.voice]]!
      return turn
    })
    print("stage join: \(fixed(Date().timeIntervalSince(joinStart), 3)) s, threshold \(fixed(options.join, 2)), "
      + "\(voices.count) window speakers -> \(Set(speakerOf.values).count) speakers, \(joined.summary)")

    for turn in merged {
      print("turn \(clock(turn.start)) \(clock(turn.end)) speaker \(turn.voice)")
    }
    var totals = [Int: Double]()
    for turn in merged { totals[turn.voice, default: 0] += turn.end - turn.start }
    for speaker in totals.keys.sorted() {
      print("speaker \(speaker): \(fixed(totals[speaker]!, 1)) s")
    }
    print("speakers: \(totals.count)")
    let total = Date().timeIntervalSince(started)
    print("total run time: \(fixed(total, 2)) s for \(fixed(audioSeconds, 1)) s of audio")
    print("real-time factor: \(fixed(total / audioSeconds, 4)) (windows only: \(fixed(diarizing / audioSeconds, 4)))")
    print("peak memory: \(peakMemoryMB()) MB")
  }

  // MARK: - Steps

  static func readChannel(_ url: URL, channel: Int, limit: Double?) throws -> (samples: [Float], rate: Int, channels: Int) {
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    let channels = Int(format.channelCount)
    guard channel < channels else { fail("the file has \(channels) channel(s); there is no channel \(channel)") }
    let wanted = limit.map { Int($0 * format.sampleRate) } ?? Int(file.length)
    let blockFrames: AVAudioFrameCount = 65_536
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: blockFrames) else {
      fail("cannot allocate an audio buffer")
    }
    var samples = [Float]()
    samples.reserveCapacity(min(wanted, Int(file.length)))
    while file.framePosition < file.length, samples.count < wanted {
      try file.read(into: buffer, frameCount: blockFrames)
      let frames = Int(buffer.frameLength)
      guard frames > 0, let data = buffer.floatChannelData else { break }
      samples.append(contentsOf: UnsafeBufferPointer(start: data[channel], count: min(frames, wanted - samples.count)))
    }
    return (samples, Int(format.sampleRate), channels)
  }

  /// Windows of `size` samples; a last piece shorter than 60 s goes into the window before it.
  static func windowRanges(count: Int, size: Int) -> [Range<Int>] {
    guard size > 0, count > size else { return [0..<count] }
    var ranges = stride(from: 0, to: count, by: size).map { $0..<min($0 + size, count) }
    if ranges.count > 1, ranges[ranges.count - 1].count < 60 * sampleRate {
      ranges.removeLast()
      ranges[ranges.count - 1] = ranges[ranges.count - 1].lowerBound..<count
    }
    return ranges
  }

  /// Joins voices from different windows, closest pair first, while the distance is below `threshold` (or while
  /// more than `maximum` speakers are left). Returns each voice's cluster and a one-line summary.
  static func join(_ voices: [Voice], threshold: Double, maximum: Int?) -> (cluster: [Int], summary: String) {
    var windows = voices.map { Set([$0.window]) }
    var centroids = voices.map(\.embedding)
    var weights = voices.map { max($0.seconds, 0.001) }
    var active = Array(voices.indices)
    var cluster = Array(voices.indices)
    var largestJoined: Double?
    var keptApart: Double?
    var forced = 0
    while true {
      var best: (i: Int, j: Int, distance: Double)?
      for (position, i) in active.enumerated() {
        for j in active[(position + 1)...] where windows[i].isDisjoint(with: windows[j]) {
          let distance = cosineDistance(centroids[i], centroids[j])
          if best == nil || distance < best!.distance { best = (i, j, distance) }
        }
      }
      guard let pair = best else { break }
      let overMaximum = maximum.map { active.count > $0 } ?? false
      if pair.distance >= threshold {
        if !overMaximum {
          keptApart = pair.distance
          break
        }
        forced += 1
      } else {
        largestJoined = max(largestJoined ?? 0, pair.distance)
      }
      let total = weights[pair.i] + weights[pair.j]
      centroids[pair.i] = zip(centroids[pair.i], centroids[pair.j]).map {
        ($0 * weights[pair.i] + $1 * weights[pair.j]) / total
      }
      weights[pair.i] = total
      windows[pair.i].formUnion(windows[pair.j])
      active.removeAll { $0 == pair.j }
      for voice in cluster.indices where cluster[voice] == pair.j { cluster[voice] = pair.i }
    }
    let summary = "largest joined distance \(largestJoined.map { fixed($0, 3) } ?? "none"), "
      + "closest pair kept apart \(keptApart.map { fixed($0, 3) } ?? "none"), forced by --max \(forced)"
    return (cluster, summary)
  }

  /// Speaker numbers 1, 2, … in order of first speech.
  static func numberByFirstSpeech(turns: [Turn], cluster: [Int]) -> [Int: Int] {
    var firstStart = [Int: Double]()
    for turn in turns {
      let id = cluster[turn.voice]
      firstStart[id] = min(firstStart[id] ?? .infinity, turn.start)
    }
    let ordered = firstStart.keys.sorted { (firstStart[$0]!, $0) < (firstStart[$1]!, $1) }
    return Dictionary(uniqueKeysWithValues: ordered.enumerated().map { ($1, $0 + 1) })
  }

  /// A speaker's turn cut by a window edge becomes one turn again (same speaker, other window, gap at most 0.5 s).
  static func mergeAcrossWindows(_ turns: [Turn]) -> [Turn] {
    var merged: [Turn] = []
    var lastOfSpeaker = [Int: Int]()
    for turn in turns.sorted(by: { ($0.start, $0.voice) < ($1.start, $1.voice) }) {
      if let index = lastOfSpeaker[turn.voice], merged[index].window != turn.window,
        turn.start - merged[index].end <= 0.5
      {
        merged[index].end = max(merged[index].end, turn.end)
        continue
      }
      lastOfSpeaker[turn.voice] = merged.count
      merged.append(turn)
    }
    return merged.sorted { ($0.start, $0.voice) < ($1.start, $1.voice) }
  }

  // MARK: - Helpers

  static func cosineDistance(_ a: [Double], _ b: [Double]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 2 }
    var dot = 0.0
    var normA = 0.0
    var normB = 0.0
    for index in a.indices {
      dot += a[index] * b[index]
      normA += a[index] * a[index]
      normB += b[index] * b[index]
    }
    let denominator = normA.squareRoot() * normB.squareRoot()
    return denominator > 1e-10 ? 1 - dot / denominator : 2
  }

  static func parse(_ arguments: [String]) -> Options {
    var options = Options()
    var index = 0
    func value() -> String {
      index += 1
      guard index < arguments.count else { fail(usage) }
      return arguments[index]
    }
    while index < arguments.count {
      switch arguments[index] {
      case "--channel": options.channel = Int(value()) ?? -1
      case "--max": options.maximum = Int(value())
      case "--min": options.minimum = Int(value()) ?? 0
      case "--window": options.window = Double(value()) ?? -1
      case "--units": options.units = value()
      case "--limit": options.limit = Double(value())
      case "--join": options.join = Double(value()) ?? -1
      default:
        guard options.path.isEmpty, !arguments[index].hasPrefix("--") else { fail(usage) }
        options.path = arguments[index]
      }
      index += 1
    }
    guard !options.path.isEmpty, options.channel == 0 || options.channel == 1, options.minimum >= 1,
      options.maximum.map({ $0 >= options.minimum }) ?? true, options.window >= 0, options.join >= 0,
      ["cpu", "ane", "all"].contains(options.units), options.limit.map({ $0 > 0 }) ?? true
    else { fail(usage) }
    return options
  }

  static func clock(_ seconds: Double) -> String {
    let hundredths = Int((seconds * 100).rounded())
    return String(
      format: "%ld:%02ld:%02ld.%02ld", hundredths / 360_000, hundredths / 6_000 % 60, hundredths / 100 % 60,
      hundredths % 100)
  }

  static func fixed(_ value: Double, _ digits: Int) -> String {
    String(format: "%.\(digits)f", value)
  }

  /// Peak resident memory of this process (`getrusage`; macOS reports bytes).
  static func peakMemoryMB() -> Int {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return Int(usage.ru_maxrss / 1_048_576)
  }

  static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}
