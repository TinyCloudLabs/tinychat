// What a launched desktop app shows (desktop-launch-check.sh). Arguments: the app's pid and a screenshot of the whole
// screen. Prints one `window ...` line per on-screen window of that pid and one `text ...` line per run of text read off
// the screenshot with the system's on-device text recognition. Reads only; sends nothing anywhere.
import CoreGraphics
import Foundation
import ImageIO
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3, let pid = Int32(arguments[1]) else {
  FileHandle.standardError.write(Data("usage: desktop-launch-observe.swift <pid> <screenshot.png>\n".utf8))
  exit(64)
}

let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
for window in windows where (window[kCGWindowOwnerPID as String] as? Int32) == pid {
  let layer = window[kCGWindowLayer as String] as? Int ?? -1
  let name = (window[kCGWindowName as String] as? String) ?? ""
  let bounds = window[kCGWindowBounds as String] as? [String: Any]
  let width = bounds?["Width"] as? Double ?? 0
  let height = bounds?["Height"] as? Double ?? 0
  print("window layer=\(layer) size=\(Int(width))x\(Int(height)) name=\(name)")
}

let url = URL(fileURLWithPath: arguments[2])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  print("screenshot unreadable")
  exit(0)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
  print("recognition failed: \(error)")
  exit(0)
}
for observation in request.results ?? [] {
  if let candidate = observation.topCandidates(1).first { print("text \(candidate.string)") }
}
