import AVFoundation
import Capacitor
import CaptureCore
import CryptoKit
import ExoCapture
import Foundation
import UIKit

@objc(VoiceNotesPlugin)
public final class VoiceNotesPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate, URLSessionTaskDelegate {
    public let identifier = "VoiceNotesPlugin"
    public let jsName = "VoiceNotes"
    public let pluginMethods: [CAPPluginMethod] = [
        "start", "stop", "status", "readAudioChunk", "deleteAudio", "evictCachedAudio", "listPending",
        "pause", "resume", "discard", "setRecordingOptions", "getCaptureDefaults",
        "setCaptureDefaults", "claim", "updateLedger", "localAudioUrl", "localAudioSize", "audioMetadata", "uploadAudio", "cancelAudioUpload", "putTranscript",
        "getTranscript", "listInputs", "selectInput", "listQuarantine",
        "deleteQuarantined", "listOutbox", "completeOutbox", "setAccountState",
        "beginRemoteOp", "recordRemoteResult", "retryRecovery", "discardFailedRecording",
        "openSettings"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private let capture = CaptureEngine.shared
    private var observer: UUID?
    private lazy var audioUploadSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private let uploadLock = NSLock()
    private var uploadCalls: [Int: (CAPPluginCall, String, Data)] = [:]
    private var uploadTasks: [String: URLSessionUploadTask] = [:]
    private var cancelledAudioUploads = Set<String>()
    private var uploadBackgroundTasks: [String: UIBackgroundTaskIdentifier] = [:]

    override public func load() {
        capture.recoverOnce()
        observer = capture.observe { [weak self] name, data, retained in
            DispatchQueue.main.async { self?.notifyListeners(name, data: data, retainUntilConsumed: retained) }
        }
    }

    deinit { if let observer { capture.removeObserver(observer) } }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        call.reject(error.localizedDescription,
                    (error as? CaptureError)?.code ?? (error as? CaptureResumeError)?.code ?? "native_error", error)
    }

    @objc func start(_ call: CAPPluginCall) {
        let requestedLimit = call.getDouble("maxDurationMs")
        if let requestedLimit,
           (!requestedLimit.isFinite || requestedLimit < 1 || requestedLimit >= Double(Int64.max)) {
            call.reject("maxDurationMs must be a positive finite number", "invalid_argument")
            return
        }
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { call.reject("Capture plugin was released", "native_error"); return }
                guard granted else { call.reject("Microphone permission denied", "permission_denied"); return }
                let current = self.capture.defaults().options
                let override = call.getString("transcriber") != nil || call.getBool("identifySpeakers") != nil
                    ? CaptureOptions(transcriber: call.getString("transcriber") ?? current.transcriber,
                                     identifySpeakers: call.getBool("identifySpeakers") ?? current.identifySpeakers) : nil
                do { call.resolve(try self.capture.start(requestedLimitMs: requestedLimit.map(Int64.init),
                                                         override: override)) }
                catch { self.reject(call, error) }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.capture.stop { result in
                switch result {
                case .success(let item): call.resolve(item)
                case .failure(let error): self.reject(call, error)
                }
            }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var result = self.capture.status()
            result["microphonePermissionGranted"] = AVAudioApplication.shared.recordPermission == .granted
            call.resolve(result)
        }
    }
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Could not open Settings", "settings_unavailable")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() }
                else { call.reject("Could not open Settings", "settings_unavailable") }
            }
        }
    }
    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { do { try self.capture.pause(); call.resolve() } catch { self.reject(call, error) } }
    }
    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { do { try self.capture.resume(); call.resolve() } catch { self.reject(call, error) } }
    }
    @objc func discard(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do { call.resolve(["id": try self.capture.discard() as Any? ?? NSNull()]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func readAudioChunk(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id),
              let offset = call.getDouble("offset"), offset.isFinite, offset >= 0,
              let length = call.getDouble("length"), length.isFinite, length > 0 else {
            call.reject("A valid id, offset and length are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let handle = try self.capture.library.openAudio(id)
                defer { try? handle.close() }
                let size = try handle.seekToEnd()
                let start = offset >= Double(size) ? size : UInt64(offset)
                try handle.seek(toOffset: start)
                let wanted = Int(min(UInt64(min(length, 4 * 1024 * 1024)), size - start))
                let data = try handle.read(upToCount: wanted) ?? Data()
                call.resolve(["id": id, "offset": Int64(start), "base64": data.base64EncodedString(),
                              "bytesRead": data.count, "size": Int64(size),
                              "eof": start + UInt64(data.count) >= size])
            } catch CaptureError.notFound { call.reject("Voice note audio not found", "not_found") }
            catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                call.reject("Voice note audio not found", "not_found", error)
            }
            catch { self.reject(call, error) }
        }
    }

    @objc func deleteAudio(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id) else {
            call.reject("A valid id is required", "invalid_argument"); return
        }
        DispatchQueue.main.async {
            guard self.capture.status()["id"] as? String != id else {
                call.reject("Recording is still in progress", "recording_in_progress"); return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                do { try self.capture.library.delete(id); call.resolve() }
                catch { self.reject(call, error) }
            }
        }
    }

    @objc func evictCachedAudio(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id) else {
            call.reject("A valid id is required", "invalid_argument"); return
        }
        DispatchQueue.main.async {
            guard self.capture.status()["id"] as? String != id else {
                call.reject("Recording is still in progress", "recording_in_progress"); return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                do { try self.capture.library.evictCachedAudio(id); call.resolve() }
                catch { self.reject(call, error) }
            }
        }
    }

    @objc func listPending(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.capture.awaitRecovery()
                call.resolve(["recordings": try self.capture.library.listCommitted()])
            }
            catch { self.reject(call, error) }
        }
    }

    @objc func setRecordingOptions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let old = self.capture.status()["options"] as? [String: Any] ?? [:]
            let changed = CaptureOptions(transcriber: call.getString("transcriber") ?? old["transcriber"] as? String ?? "on-device",
                                         identifySpeakers: call.getBool("identifySpeakers") ?? old["identifySpeakers"] as? Bool ?? false)
            do { try self.capture.setRecordingOptions(changed); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func getCaptureDefaults(_ call: CAPPluginCall) {
        do {
            let state = try capture.accountState()
            call.resolve(["status": state.status, "accountDid": state.accountDid as Any? ?? NSNull(),
                          "transitionGen": state.transitionGen, "transcriber": state.options.transcriber,
                          "identifySpeakers": state.options.identifySpeakers])
        } catch { reject(call, error) }
    }

    @objc func setAccountState(_ call: CAPPluginCall) {
        guard let status = call.getString("status"),
              let gen = call.getDouble("transitionGen"), gen.isFinite, gen >= 0,
              gen < Double(Int64.max), gen.rounded(.towardZero) == gen else {
            call.reject("status and transitionGen are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.setAccountState(status: status, accountDid: call.getString("accountDid"),
                                                   transitionGen: Int64(gen)); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func beginRemoteOp(_ call: CAPPluginCall) {
        let receipt = Dictionary(uniqueKeysWithValues: call.options.compactMap { key, value -> (String, Any)? in
            guard let name = key as? String else { return nil }
            return (name, value)
        })
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.library.beginRemoteOp(receipt); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func recordRemoteResult(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let did = call.getString("did"),
              let opId = call.getString("opId"), let result = call.getObject("result") else {
            call.reject("id, did, opId and result are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["destination": try self.capture.library.recordRemoteResult(
                id: id, did: did, opId: opId, result: result)]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func retryRecovery(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id) else {
            call.reject("A valid id is required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.retryRecovery(id); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func discardFailedRecording(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id) else {
            call.reject("A valid id is required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.discardFailedRecording(id); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func setCaptureDefaults(_ call: CAPPluginCall) {
        guard let gen = call.getDouble("transitionGen"), gen.isFinite, gen >= 0,
              gen < Double(Int64.max), gen.rounded(.towardZero) == gen else {
            call.reject("transitionGen is required", "invalid_argument"); return
        }
        DispatchQueue.main.async {
            do {
                let current = self.capture.defaults()
                let next = CaptureDefaults(accountDid: call.getString("accountDid"), transitionGen: Int64(gen),
                                           transcriber: call.getString("transcriber") ?? current.transcriber,
                                           identifySpeakers: call.getBool("identifySpeakers") ?? current.identifySpeakers)
                call.resolve(["claimed": try self.capture.setDefaults(next)])
            } catch { self.reject(call, error) }
        }
    }

    @objc func claim(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let did = call.getString("did"),
              let evidence = call.getString("evidence") else {
            call.reject("id, did and evidence are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["owner": try self.capture.library.claim(id, did: did, evidence: evidence,
                                                                         rowId: call.getString("rowId")) as Any? ?? NSNull()]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func updateLedger(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let did = call.getString("did"),
              let rev = call.getInt("rev"), let patch = call.getObject("patch") else {
            call.reject("id, did, rev and patch are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["rev": try self.capture.library.updateLedger(id, did: did, rev: rev, patch: patch)]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func localAudioUrl(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id) else {
            call.reject("A valid id is required", "invalid_argument"); return
        }
        do { call.resolve(["url": try capture.library.localAudioURL(id).absoluteString]) }
        catch { reject(call, error) }
    }

    @objc func localAudioSize(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), RecordingLibrary.validID(id) else {
            call.reject("A valid id is required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let url = try self.capture.library.localAudioURL(id)
                let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
                call.resolve(["size": size])
            } catch CaptureError.notFound { call.resolve(["size": 0]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func audioMetadata(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let url = try self.capture.library.localAudioURL(id)
                let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
                let digest = SHA256.hash(data: try Data(contentsOf: url, options: .mappedIfSafe))
                call.resolve(["size": size, "mimeType": "audio/mp4", "sha256": digest.map { String(format: "%02x", $0) }.joined()])
            } catch { self.reject(call, error) }
        }
    }

    @objc func uploadAudio(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let uploadId = call.getString("uploadId"),
              let rawURL = call.getString("url"), let url = URL(string: rawURL),
              let capability = call.getString("capability"), let contentType = call.getString("contentType"),
              let contentLength = call.getInt("contentLength"), contentLength > 0 else {
            call.reject("Invalid audio upload request", "invalid_argument"); return
        }
        do {
            let fileURL = try capture.library.localAudioURL(id)
            let actual = (try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.intValue
            guard actual == contentLength else { call.reject("not_found", "not_found"); return }
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue("Bearer \(capability)", forHTTPHeaderField: "Authorization")
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.setValue(String(contentLength), forHTTPHeaderField: "Content-Length")
            request.setValue(call.getString("correlationId") ?? uploadId, forHTTPHeaderField: "X-Correlation-Id")
            let task = audioUploadSession.uploadTask(with: request, fromFile: fileURL)
            var backgroundTask: UIBackgroundTaskIdentifier = .invalid
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Voice note upload") { [weak self] in
                self?.expireNativeAudioUpload(uploadId, backgroundTask: backgroundTask)
            }
            uploadLock.lock()
            if cancelledAudioUploads.remove(uploadId) != nil {
                uploadLock.unlock()
                if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask) }
                call.reject("The upload was cancelled before it started", "transcription_off")
                return
            }
            uploadTasks[uploadId] = task
            uploadBackgroundTasks[uploadId] = backgroundTask
            uploadCalls[task.taskIdentifier] = (call, uploadId, Data())
            uploadLock.unlock()
            task.resume()
        } catch { reject(call, error) }
    }

    @objc func cancelAudioUpload(_ call: CAPPluginCall) {
        guard let uploadId = call.getString("uploadId") else { call.reject("uploadId is required", "invalid_argument"); return }
        cancelNativeAudioUpload(uploadId)
        call.resolve()
    }

    private func cancelNativeAudioUpload(_ uploadId: String) {
        uploadLock.lock()
        cancelledAudioUploads.insert(uploadId)
        let task = uploadTasks.removeValue(forKey: uploadId)
        uploadLock.unlock()
        task?.cancel()
    }

    private func expireNativeAudioUpload(_ uploadId: String, backgroundTask: UIBackgroundTaskIdentifier) {
        uploadLock.lock()
        cancelledAudioUploads.insert(uploadId)
        let task = uploadTasks.removeValue(forKey: uploadId)
        let registeredTask = uploadBackgroundTasks.removeValue(forKey: uploadId)
        uploadLock.unlock()
        task?.cancel()
        let taskToEnd = registeredTask ?? backgroundTask
        if taskToEnd != .invalid { UIApplication.shared.endBackgroundTask(taskToEnd) }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                           totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        uploadLock.lock()
        let entry = uploadCalls[task.taskIdentifier]
        uploadLock.unlock()
        guard let entry else { return }
        DispatchQueue.main.async {
            self.notifyListeners("audioUploadProgress", data: ["uploadId": entry.1, "loaded": totalBytesSent, "total": totalBytesExpectedToSend])
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        uploadLock.lock()
        guard let entry = uploadCalls[dataTask.taskIdentifier] else { uploadLock.unlock(); return }
        uploadCalls[dataTask.taskIdentifier] = (entry.0, entry.1, entry.2 + data)
        uploadLock.unlock()
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        uploadLock.lock()
        let entry = uploadCalls.removeValue(forKey: task.taskIdentifier)
        let backgroundTask = entry.flatMap { uploadBackgroundTasks.removeValue(forKey: $0.1) }
        if let entry {
            uploadTasks.removeValue(forKey: entry.1)
            cancelledAudioUploads.remove(entry.1)
        }
        uploadLock.unlock()
        if let backgroundTask, backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask) }
        guard let entry else { return }
        if let error { entry.0.reject("Upload connection failed", "upload_outcome_unknown", error); return }
        let response = task.response as? HTTPURLResponse
        var body: Any = NSNull()
        if !entry.2.isEmpty { body = (try? JSONSerialization.jsonObject(with: entry.2)) ?? NSNull() }
        entry.0.resolve(["status": response?.statusCode ?? 0, "body": body])
    }

    @objc func putTranscript(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let transcript = call.getObject("transcript") else {
            call.reject("id and transcript are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.library.putTranscript(id, object: transcript); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func getTranscript(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["transcript": try self.capture.library.transcript(id) as Any? ?? NSNull()]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func listInputs(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do { call.resolve(try self.capture.listInputs()) }
            catch { self.reject(call, error) }
        }
    }
    @objc func selectInput(_ call: CAPPluginCall) {
        guard call.options["id"] is NSNull || call.getString("id") != nil else {
            call.reject("id must be an input UID or null", "invalid_argument"); return
        }
        DispatchQueue.main.async {
            do { try self.capture.selectInput(call.getString("id")); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func listQuarantine(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["items": try self.capture.library.listQuarantine()]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func deleteQuarantined(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.library.deleteQuarantined(id); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    @objc func listOutbox(_ call: CAPPluginCall) {
        guard let did = call.getString("did") else { call.reject("did is required", "invalid_argument"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["entries": try self.capture.library.listOutbox(did: did)]) }
            catch { self.reject(call, error) }
        }
    }

    @objc func completeOutbox(_ call: CAPPluginCall) {
        guard let id = call.getString("entryId"), let result = call.getString("result") else {
            call.reject("entryId and result are required", "invalid_argument"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try self.capture.library.completeOutbox(id, result: result); call.resolve() }
            catch { self.reject(call, error) }
        }
    }
}
