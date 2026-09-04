import Foundation
import CoreGraphics
import ImageIO
import AppKit
import UniformTypeIdentifiers

// The link preview card for every page that is NOT the Cleopatra story.
//
// 1200x630 is the size Open Graph, iMessage, Slack, X and LinkedIn all crop
// from, so it is the one to author at. The old card was the Cleopatra plate
// and a headline about her — which sold one story on every URL we own. This
// one sells the SEASON: a wall of the actual paintings, the mark, and what
// the thing is.
//
// Rendered cgImage -> opaque CGContext -> CGImageDestination, never NSImage:
// that path has produced pure black output in this repo before, and it passed
// every metadata check. Hence the luminance assertion at the end.

let W = 1200, H = 630
let args = CommandLine.arguments
guard args.count >= 4 else {
    fputs("usage: build-share-card <thumbsDir> <logo.png> <out.jpg>\n", stderr); exit(1)
}
let thumbsDir = args[1], logoPath = args[2], outPath = args[3]

func load(_ p: String) -> CGImage? {
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(s, 0, nil)
}

// A fixed, spread-out pick so the card does not become six paintings of the
// same colour. Sorted for determinism: the card must be byte-stable across
// rebuilds or every social cache re-fetches for nothing.
let all = (try? FileManager.default.contentsOfDirectory(atPath: thumbsDir))?
    .filter { $0.hasSuffix(".webp") }.sorted() ?? []
guard all.count >= 12 else { fputs("not enough thumbnails\n", stderr); exit(1) }

let cols = 8, rows = 5
let cellW = Double(W) / Double(cols), cellH = Double(H) / Double(rows)
var picks: [String] = []
let stride_ = max(1, all.count / (cols * rows))
var i = 0
while picks.count < cols * rows {
    picks.append(all[(i * stride_) % all.count]); i += 1
}

var buf = [UInt8](repeating: 0, count: W * H * 4)
let ctx = CGContext(data: &buf, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.interpolationQuality = .high

// Ground first, so a thumbnail that fails to decode leaves brand navy and not
// a black hole.
ctx.setFillColor(CGColor(red: 0x0F/255.0, green: 0x14/255.0, blue: 0x20/255.0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

var drawn = 0
for r in 0..<rows {
    for c in 0..<cols {
        let name = picks[r * cols + c]
        guard let img = load(thumbsDir + "/" + name) else { continue }
        let dst = CGRect(x: Double(c) * cellW, y: Double(r) * cellH, width: cellW, height: cellH)
        // aspect-fill the cell
        let sw = Double(img.width), sh = Double(img.height)
        let scale = max(dst.width / sw, dst.height / sh)
        let dw = sw * scale, dh = sh * scale
        ctx.saveGState()
        ctx.clip(to: dst)
        ctx.draw(img, in: CGRect(x: dst.midX - dw/2, y: dst.midY - dh/2, width: dw, height: dh))
        ctx.restoreGState()
        drawn += 1
    }
}

// Darken the whole wall so the mark reads. Two passes: a flat scrim for
// legibility, then a radial-ish deepening behind the centre panel.
ctx.setFillColor(CGColor(red: 0x09/255.0, green: 0x0C/255.0, blue: 0x16/255.0, alpha: 0.62))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

let panelW = 690.0, panelH = 330.0
let panel = CGRect(x: (Double(W) - panelW)/2, y: (Double(H) - panelH)/2, width: panelW, height: panelH)
if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                         colors: [CGColor(red: 0x09/255.0, green: 0x0C/255.0, blue: 0x16/255.0, alpha: 0.86),
                                  CGColor(red: 0x09/255.0, green: 0x0C/255.0, blue: 0x16/255.0, alpha: 0.0)] as CFArray,
                         locations: [0, 1]) {
    ctx.saveGState()
    ctx.drawRadialGradient(grad, startCenter: CGPoint(x: panel.midX, y: panel.midY), startRadius: 60,
                           endCenter: CGPoint(x: panel.midX, y: panel.midY), endRadius: 520,
                           options: [.drawsAfterEndLocation])
    ctx.restoreGState()
}

// ---- the mark and the words -------------------------------------------
func drawText(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor,
              tracking: CGFloat, centerX: Double, baselineY: Double) {
    let f = NSFont.systemFont(ofSize: size, weight: weight)
    let rounded = NSFont(descriptor: f.fontDescriptor.withDesign(.rounded) ?? f.fontDescriptor, size: size) ?? f
    let attrs: [NSAttributedString.Key: Any] = [
        .font: rounded, .foregroundColor: color, .kern: tracking
    ]
    let a = NSAttributedString(string: s, attributes: attrs)
    let line = CTLineCreateWithAttributedString(a)
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
    ctx.textPosition = CGPoint(x: centerX - Double(bounds.width) / 2, y: baselineY)
    CTLineDraw(line, ctx)
}

let mid = Double(W) / 2
if let logo = load(logoPath) {
    let side = 132.0
    ctx.draw(logo, in: CGRect(x: mid - side/2, y: 392, width: side, height: side))
}
drawText("FACTBOX", size: 34, weight: .heavy, color: NSColor(calibratedRed: 0x8F/255.0, green: 0xC4/255.0, blue: 0xFA/255.0, alpha: 1), tracking: 11, centerX: mid, baselineY: 330)
drawText("Be disgustingly well-informed.", size: 62, weight: .bold, color: NSColor(calibratedRed: 0xF4/255.0, green: 0xEF/255.0, blue: 0xE6/255.0, alpha: 1), tracking: -1.0, centerX: mid, baselineY: 244)
drawText("Fifty-one history stories, five minutes each,", size: 30, weight: .medium, color: NSColor(calibratedRed: 0xF4/255.0, green: 0xEF/255.0, blue: 0xE6/255.0, alpha: 0.86), tracking: 0, centerX: mid, baselineY: 190)
drawText("told on paintings from the world\u{2019}s museums.", size: 30, weight: .medium, color: NSColor(calibratedRed: 0xF4/255.0, green: 0xEF/255.0, blue: 0xE6/255.0, alpha: 0.86), tracking: 0, centerX: mid, baselineY: 148)

guard let out = ctx.makeImage() else { fputs("makeImage failed\n", stderr); exit(1) }
let url = URL(fileURLWithPath: outPath) as CFURL
guard let dest = CGImageDestinationCreateWithURL(url, UTType.jpeg.identifier as CFString, 1, nil) else {
    fputs("destination failed\n", stderr); exit(1)
}
CGImageDestinationAddImage(dest, out, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { fputs("finalize failed\n", stderr); exit(1) }

// Mean luminance, because a black card passes every metadata check there is.
var sum = 0.0, n = 0
for idx in stride(from: 0, to: W * H * 4, by: 4 * 53) {
    sum += (0.2126 * Double(buf[idx]) + 0.7152 * Double(buf[idx+1]) + 0.0722 * Double(buf[idx+2])) / 255
    n += 1
}
print(String(format: "%dx%d  thumbnails drawn %d/%d  mean luminance %.3f", W, H, drawn, cols*rows, sum / Double(n)))
if sum / Double(n) < 0.04 { fputs("REFUSING: card is essentially black\n", stderr); exit(1) }
