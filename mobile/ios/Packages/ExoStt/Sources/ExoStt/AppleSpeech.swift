#if os(iOS)
import AVFoundation
import CoreMedia
import Foundation
import Speech

enum AppleSpeechError: Error {
    case noAudioFormat
    case audioConversionFailed
    case phraseWithoutTimes
    case notInstallable(AppleSpeechState)
}

/// Which of Apple's speech modules Local transcription runs, chosen once here. `SpeechTranscriber` is
/// the accurate one but needs newer silicon (it is unavailable on A13 phones and on the simulator);
/// `DictationTranscriber` runs through the same `SpeechAnalyzer` path everywhere else.
enum AppleSpeechKind {
    case speechTranscriber
    case dictationTranscriber

    static var preferred: AppleSpeechKind { SpeechTranscriber.isAvailable ? .speechTranscriber : .dictationTranscriber }

    /// The transcript's `model`.
    var modelName: String { self == .speechTranscriber ? "speech-transcriber" : "dictation-transcriber" }

    func supportedLocales() async -> [Locale] {
        switch self {
        case .speechTranscriber: return await SpeechTranscriber.supportedLocales
        case .dictationTranscriber: return await DictationTranscriber.supportedLocales
        }
    }

    func supportedLocale(equivalentTo locale: Locale) async -> Locale? {
        switch self {
        case .speechTranscriber: return await SpeechTranscriber.supportedLocale(equivalentTo: locale)
        case .dictationTranscriber: return await DictationTranscriber.supportedLocale(equivalentTo: locale)
        }
    }

    func installedLocales() async -> [Locale] {
        switch self {
        case .speechTranscriber: return await SpeechTranscriber.installedLocales
        case .dictationTranscriber: return await DictationTranscriber.installedLocales
        }
    }

    func makeModule(locale: Locale) -> AppleSpeechModule {
        switch self {
        case .speechTranscriber:
            return .speech(SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                                             attributeOptions: [.audioTimeRange]))
        case .dictationTranscriber:
            return .dictation(DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
                                                   reportingOptions: [], attributeOptions: [.audioTimeRange]))
        }
    }
}

/// A constructed module, with its results read as `SpeechPhrase`s.
enum AppleSpeechModule {
    case speech(SpeechTranscriber)
    case dictation(DictationTranscriber)

    var module: any SpeechModule {
        switch self {
        case .speech(let transcriber): return transcriber
        case .dictation(let transcriber): return transcriber
        }
    }

    /// Calls `onPhrase` for every final result until the analyzer finishes.
    func recognize(onPhrase: @escaping @Sendable (SpeechPhrase) -> Void) async throws {
        switch self {
        case .speech(let transcriber):
            for try await result in transcriber.results where result.isFinal {
                onPhrase(try Self.phrase(String(result.text.characters), result.range))
            }
        case .dictation(let transcriber):
            for try await result in transcriber.results where result.isFinal {
                onPhrase(try Self.phrase(String(result.text.characters), result.range))
            }
        }
    }

    private static func phrase(_ text: String, _ range: CMTimeRange) throws -> SpeechPhrase {
        let start = range.start.seconds, end = range.end.seconds
        guard start.isFinite, end.isFinite else { throw AppleSpeechError.phraseWithoutTimes }
        return SpeechPhrase(text: text, startSeconds: start, endSeconds: end)
    }
}

/// Whether Apple's speech assets for this phone's language are installed, and the one place that installs
/// them. The OS owns the assets (shared across apps, outside this app's storage), so there is no Wi-Fi gate
/// or progress to manage here; the state is re-derived from the OS each time `refresh()` runs.
public final class AppleSpeechAssets {
    public static let shared = AppleSpeechAssets()

    struct Target {
        let kind: AppleSpeechKind
        let locale: Locale
    }

    private let lock = NSLock()
    private var state = AppleSpeechState.unsupported
    private var install = AppleSpeechInstall.idle
    private var installTask: Task<Void, Error>?
    private var target: Target?
    private var checked = false
    private var checkWaiters: [() -> Void] = []
    /// Called (on any thread) when the state or the install progress changed.
    public var onChanged: (() -> Void)?

    public var hasChecked: Bool {
        lock.lock(); defer { lock.unlock() }
        return checked
    }

    public var current: (state: AppleSpeechState, install: AppleSpeechInstall) {
        lock.lock(); defer { lock.unlock() }
        return (state, install)
    }

    /// Runs `block` once the first `refresh()` has finished, or right away if it already has.
    public func whenChecked(_ block: @escaping () -> Void) {
        lock.lock()
        if checked {
            lock.unlock()
            block()
        } else {
            checkWaiters.append(block)
            lock.unlock()
        }
    }

    /// Re-reads the phone's speech support and installed assets. Returns the module and language to
    /// transcribe with once the phone is `ready`, otherwise nil.
    @discardableResult
    func refresh() async -> Target? {
        let kind = AppleSpeechKind.preferred
        var newState = AppleSpeechState.unsupported
        var newTarget: Target?
        if !(await kind.supportedLocales()).isEmpty {
            if let locale = await kind.supportedLocale(equivalentTo: Locale.current) {
                newTarget = Target(kind: kind, locale: locale)
                let installed = await kind.installedLocales()
                newState = installed.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) } ? .ready : .assetMissing
            } else {
                newState = .localeUnsupported
            }
        }
        let (changed, waiters) = lock.withLock { () -> (Bool, [() -> Void]) in
            let changed = !checked || state != newState
            state = newState
            target = newTarget
            checked = true
            defer { checkWaiters = [] }
            return (changed, checkWaiters)
        }
        for waiter in waiters { waiter() }
        if changed { onChanged?() }
        return newState == .ready ? newTarget : nil
    }

    /// Has the OS install this language's speech assets, joining an install already running. Returns once
    /// they are installed; throws if the OS could not, or the phone cannot install them at all.
    public func installAssets() async throws {
        let task = lock.withLock { () -> Task<Void, Error> in
            let task = installTask ?? Task { try await self.runInstall() }
            installTask = task
            return task
        }
        try await task.value
    }

    private func runInstall() async throws {
        defer { lock.withLock { installTask = nil } }
        await refresh()
        let (target, state) = lock.withLock { (self.target, self.state) }
        guard state != .ready else { return }
        guard state == .assetMissing, let target else { throw AppleSpeechError.notInstallable(state) }
        setInstall(.running)
        do {
            let module = target.kind.makeModule(locale: target.locale)
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module.module]) {
                try await request.downloadAndInstall()
            }
        } catch {
            setInstall(.failed)
            throw error
        }
        setInstall(.idle)
        await refresh()
    }

    private func setInstall(_ newInstall: AppleSpeechInstall) {
        lock.withLock { install = newInstall }
        onChanged?()
    }
}

/// A note's audio as the lazy `AnalyzerInput` stream `SpeechAnalyzer` pulls from: about a second of audio
/// is read and converted per pull, so memory never scales with the note's length (TC-836: a note left
/// recording for a long time once OOM'd a whole-array decode). `checkCapturing` runs before every
/// buffer; when it throws, or a read fails, the stream ends and `failure` holds the reason, because the
/// analyzer would otherwise report a truncated note as a finished one.
final class SpeechAudioFeed: AsyncSequence, @unchecked Sendable {
    typealias Element = AnalyzerInput

    private let file: AVAudioFile
    private let format: AVAudioFormat
    private let converter: AVAudioConverter?
    private let checkCapturing: () throws -> Void
    private let lock = NSLock()
    private var finished = false
    private var storedFailure: Error?
    private var storedBuffersFed = 0

    init(url: URL, format: AVAudioFormat, checkCapturing: @escaping () throws -> Void) throws {
        file = try AVAudioFile(forReading: url)
        self.format = format
        converter = file.processingFormat == format ? nil : AVAudioConverter(from: file.processingFormat, to: format)
        if converter == nil, file.processingFormat != format { throw AppleSpeechError.audioConversionFailed }
        self.checkCapturing = checkCapturing
    }

    var failure: Error? {
        lock.lock(); defer { lock.unlock() }
        return storedFailure
    }

    var buffersFed: Int {
        lock.lock(); defer { lock.unlock() }
        return storedBuffersFed
    }

    struct Iterator: AsyncIteratorProtocol {
        let feed: SpeechAudioFeed
        mutating func next() async -> AnalyzerInput? { feed.nextInput() }
    }

    func makeAsyncIterator() -> Iterator { Iterator(feed: self) }

    private func nextInput() -> AnalyzerInput? {
        guard !isFinished else { return nil }
        do {
            while true {
                try checkCapturing()
                let remaining = file.length - file.framePosition
                let chunk: AVAudioPCMBuffer?
                if remaining > 0 {
                    let frames = AVAudioFrameCount(Swift.min(Int64(file.processingFormat.sampleRate), remaining))
                    guard let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else { throw AppleSpeechError.audioConversionFailed }
                    try file.read(into: input, frameCount: frames)
                    chunk = input
                } else {
                    chunk = nil // The end of the file: flush what the converter still holds.
                    finish()
                }
                if let output = try convert(chunk), output.frameLength > 0 {
                    lock.lock(); storedBuffersFed += 1; lock.unlock()
                    return AnalyzerInput(buffer: output)
                }
                if chunk == nil { return nil }
            }
        } catch {
            lock.lock(); storedFailure = error; finished = true; lock.unlock()
            return nil
        }
    }

    private var isFinished: Bool {
        lock.lock(); defer { lock.unlock() }
        return finished
    }

    private func finish() {
        lock.lock(); finished = true; lock.unlock()
    }

    /// `input` nil signals the end of the stream.
    private func convert(_ input: AVAudioPCMBuffer?) throws -> AVAudioPCMBuffer? {
        guard let converter else { return input }
        let ratio = format.sampleRate / file.processingFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(input?.frameLength ?? 0) * ratio) + 4096
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw AppleSpeechError.audioConversionFailed }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if supplied || input == nil {
                outStatus.pointee = input == nil ? .endOfStream : .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }
        if let error { throw error }
        if status == .error { throw AppleSpeechError.audioConversionFailed }
        return output
    }
}

final class AppleSpeechSession: TranscriptionSession {
    private let target: AppleSpeechAssets.Target
    private let audioURL: (String) -> URL

    init(target: AppleSpeechAssets.Target, audioURL: @escaping (String) -> URL) {
        self.target = target
        self.audioURL = audioURL
    }

    var runPatch: [String: Any] { ["engine": "apple-speech", "pack": NSNull()] }

    func transcribe(id: String, checkCapturing: @escaping () throws -> Void,
                    onProgress: @escaping (Int, Int) -> Void, onSegment: @escaping (Int) -> Void) throws -> [String: Any] {
        let url = audioURL(id)
        let outcome = BlockingResult<[SpeechPhrase]>()
        Task.detached(priority: .utility) { [self] in
            do {
                outcome.finish(.success(try await recognize(url, checkCapturing: checkCapturing, onProgress: onProgress, onSegment: onSegment)))
            } catch {
                outcome.finish(.failure(error))
            }
        }
        let segments = SpeechTranscript.segments(try outcome.wait())
        return [
            "version": 2, "noteId": id, "transcriber": "on-device", "rev": 1,
            "engine": "apple-speech", "model": target.kind.modelName, "language": target.locale.identifier(.bcp47),
            "outcome": segments.isEmpty ? "no_speech" : "transcribed", "diarized": false,
            "segments": segments, "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
    }

    private func recognize(_ url: URL, checkCapturing: @escaping () throws -> Void,
                           onProgress: @escaping (Int, Int) -> Void, onSegment: @escaping (Int) -> Void) async throws -> [SpeechPhrase] {
        let duration = durationSeconds(url)
        let module = target.kind.makeModule(locale: target.locale)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module.module]) else {
            throw AppleSpeechError.noAudioFormat
        }
        let feed = try SpeechAudioFeed(url: url, format: format, checkCapturing: checkCapturing)
        let analyzer = SpeechAnalyzer(modules: [module.module])
        let phrases = PhraseLog()
        let collector = Task {
            try await module.recognize { phrase in
                let percent = SpeechTranscript.percent(recognizedSeconds: phrase.endSeconds, durationSeconds: duration)
                let (count, advanced) = phrases.append(phrase, percent: percent)
                if advanced { onProgress(percent, feed.buffersFed) }
                onSegment(count)
            }
        }
        do {
            let last = try await analyzer.analyzeSequence(feed)
            if let failure = feed.failure { throw failure }
            if let last {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            await analyzer.cancelAndFinishNow()
            collector.cancel()
            throw error
        }
        try await collector.value
        return phrases.all
    }

    /// The note's length from its container; does not decode any audio. Nil if the file can't be opened.
    private func durationSeconds(_ url: URL) -> Double? {
        guard let file = try? AVAudioFile(forReading: url), file.length > 0, file.processingFormat.sampleRate > 0 else { return nil }
        return Double(file.length) / file.processingFormat.sampleRate
    }
}

private final class PhraseLog: @unchecked Sendable {
    private let lock = NSLock()
    private var phrases: [SpeechPhrase] = []
    private var lastPercent = -1

    /// The phrase count, and whether `percent` moved past the last one reported: progress is persisted and
    /// announced only when the percent moves (each is a durable sidecar write and a bridge event).
    func append(_ phrase: SpeechPhrase, percent: Int) -> (count: Int, advanced: Bool) {
        lock.lock(); defer { lock.unlock() }
        phrases.append(phrase)
        defer { lastPercent = max(lastPercent, percent) }
        return (phrases.count, percent > lastPercent)
    }

    var all: [SpeechPhrase] {
        lock.lock(); defer { lock.unlock() }
        return phrases
    }
}

/// Hands an async result to the synchronous `TranscriptionSession` protocol, whose caller is the queue's
/// dedicated serial work queue (never the main thread).
final class BlockingResult<Value>: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private var result: Result<Value, Error>?

    func finish(_ result: Result<Value, Error>) {
        self.result = result
        semaphore.signal()
    }

    func wait() throws -> Value {
        semaphore.wait()
        return try result!.get()
    }
}
#endif
