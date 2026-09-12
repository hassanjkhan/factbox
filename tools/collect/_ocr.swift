// _ocr.swift — read the text off a screenshot using the Vision framework that
// ships with macOS. OFFLINE. No service, no upload, no key, no account.
//
// WHY THIS EXISTS AT ALL. Instagram's per-second retention curve is drawn in
// the mobile app and, as far as anyone here has been able to establish,
// nowhere on the web. This is the fallback for that one screen: the owner
// screenshots his own Insights, AirDrops it over, and the numbers get read
// off the picture instead of typed.
//
// It prints JSON on stdout: every recognised string with its box, in the
// screenshot's own pixel coordinates, top-left origin. Vision reports boxes
// bottom-left and normalised 0-1, so the flip happens here — a caller trying
// to pair a label with the number to its right should not have to know that.
//
// It makes NO attempt to decide which number is which. That is ocr.py's job,
// and keeping it there means the pairing rules can be changed without a
// recompile.

import Foundation
import Vision
import AppKit

struct Box: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct Line: Codable { let text: String; let confidence: Double; let box: Box }

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: _ocr.swift <image>\n".data(using: .utf8)!)
    exit(2)
}
let path = args[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not read an image from \(path)\n".data(using: .utf8)!)
    exit(2)
}

let W = Double(cg.width), H = Double(cg.height)

let request = VNRecognizeTextRequest()
// ACCURATE, NOT FAST. This runs on a handful of screenshots a night, not a
// video stream, and the difference between the two levels is exactly the
// difference between reading "12.3K" and reading "123K".
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false   // these are numbers; "correcting" them is damage
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

var lines: [Line] = []
for obs in (request.results ?? []) {
    guard let best = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox            // normalised, bottom-left origin
    lines.append(Line(
        text: best.string,
        confidence: Double(best.confidence),
        // to pixels, top-left origin
        box: Box(x: Double(bb.minX) * W,
                 y: (1.0 - Double(bb.maxY)) * H,
                 w: Double(bb.width) * W,
                 h: Double(bb.height) * H)))
}

struct Out: Codable { let width: Int; let height: Int; let lines: [Line] }
let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try enc.encode(Out(width: cg.width, height: cg.height, lines: lines))
FileHandle.standardOutput.write(data)
