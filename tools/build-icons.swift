import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Rebuild the Factbox icon as a set, rather than resizing the source.
//
// The source cannot simply be scaled: its opaque tile is 1172x1130, so any
// square output stretches it 3.7%, and its navy is a diagonal gradient
// (#08397E -> #001A46) that turns to mud at 16px. It also carries an outer
// drop shadow, which at favicon sizes is a grey fringe and nothing else.
//
// So: lift the cream mark out as an anti-aliased mask, and redraw it on a
// square tile in one flat navy. Geometry is preserved exactly (no tracing);
// only the things that do not survive scaling are rebuilt.

let NAVY  = (r: 0x02/255.0, g: 0x2A/255.0, b: 0x65/255.0)   // area-weighted mean of the source tile
let CREAM = (r: 0xFA/255.0, g: 0xF6/255.0, b: 0xEF/255.0)

let args = CommandLine.arguments
guard args.count > 2 else { fputs("usage: build <src.png> <outdir>\n", stderr); exit(1) }
let outDir = args[2]

// ---- lift the mark ------------------------------------------------------
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil)!
let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let w = img.width, h = img.height
var buf = [UInt8](repeating: 0, count: w*h*4)
let rc = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4,
                   space: CGColorSpaceCreateDeviceRGB(),
                   bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
rc.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))

// Creamness, as a soft ramp rather than a threshold, so edges stay smooth.
// The mark is the only light thing in the image; the navy sits far below.
var mask = [UInt8](repeating: 0, count: w*h)
for i in 0..<(w*h) {
    let r = Double(buf[i*4]), g = Double(buf[i*4+1]), b = Double(buf[i*4+2]), a = Double(buf[i*4+3])/255
    let lum = (0.2126*r + 0.7152*g + 0.0722*b) / 255
    let t = min(1, max(0, (lum - 0.34) / 0.30))          // 0 at navy, 1 at cream
    mask[i] = UInt8((t * a * 255).rounded())
}
var mx0 = w, my0 = h, mx1 = -1, my1 = -1
for y in 0..<h { for x in 0..<w where mask[y*w+x] > 128 {
    if x < mx0 { mx0 = x }; if x > mx1 { mx1 = x }
    if y < my0 { my0 = y }; if y > my1 { my1 = y } } }
let mW = mx1-mx0+1, mH = my1-my0+1
print("mark lifted: \(mW) x \(mH) at (\(mx0),\(my0))")

// Mask -> a cream image with that alpha.
var markPx = [UInt8](repeating: 0, count: mW*mH*4)
for y in 0..<mH { for x in 0..<mW {
    let a = Double(mask[(y+my0)*w + (x+mx0)]) / 255
    let o = (y*mW + x)*4
    markPx[o]   = UInt8((CREAM.r * a * 255).rounded())   // premultiplied
    markPx[o+1] = UInt8((CREAM.g * a * 255).rounded())
    markPx[o+2] = UInt8((CREAM.b * a * 255).rounded())
    markPx[o+3] = UInt8((a * 255).rounded()) } }
let markCtx = CGContext(data: &markPx, width: mW, height: mH, bitsPerComponent: 8, bytesPerRow: mW*4,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let markImg = markCtx.makeImage()!

// ---- draw one icon ------------------------------------------------------
// `frac` is how much of the tile's width the mark spans. Small icons get a
// bigger mark: the left bar is 7% of the mark's width, which at 16px is one
// pixel, and one pixel of cream with padding around it is a smudge.
// `radius` is 0 for apple-touch-icon, which iOS masks itself — shipping a
// pre-rounded one there puts transparent corners inside Apple's own rounding.
func render(_ size: Int, frac: Double, radiusFrac: Double, path: String) {
    var out = [UInt8](repeating: 0, count: size*size*4)
    let c = CGContext(data: &out, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size*4,
                      space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    let S = Double(size)
    let r = radiusFrac * S
    let rect = CGRect(x: 0, y: 0, width: S, height: S)
    let p = CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    c.addPath(p); c.setFillColor(CGColor(red: NAVY.r, green: NAVY.g, blue: NAVY.b, alpha: 1)); c.fillPath()

    // Fit the mark inside `frac` of the tile, preserving its aspect, centred.
    let maxW = S * frac, maxH = S * frac
    let scale = min(maxW / Double(mW), maxH / Double(mH))
    let dw = Double(mW) * scale, dh = Double(mH) * scale
    c.draw(markImg, in: CGRect(x: (S-dw)/2, y: (S-dh)/2, width: dw, height: dh))

    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                               UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, c.makeImage()!, nil)
    _ = CGImageDestinationFinalize(dest)
    print("  \(path)  \(size)px  mark \(Int(frac*100))%  radius \(Int(radiusFrac*100))%")
}

print("writing:")
render(512, frac: 0.56, radiusFrac: 0.22, path: "\(outDir)/icon-512.png")
render(96,  frac: 0.56, radiusFrac: 0.22, path: "\(outDir)/logo-96.png")
// Maskable: full bleed, mark well inside the 80% safe zone the launcher keeps.
render(512, frac: 0.50, radiusFrac: 0.00, path: "\(outDir)/icon-maskable-512.png")
render(192, frac: 0.56, radiusFrac: 0.22, path: "\(outDir)/icon-192.png")
render(180, frac: 0.60, radiusFrac: 0.00, path: "\(outDir)/apple-touch-icon.png")  // iOS masks it
render(48,  frac: 0.64, radiusFrac: 0.20, path: "\(outDir)/icon-48.png")
render(32,  frac: 0.68, radiusFrac: 0.19, path: "\(outDir)/icon-32.png")
render(16,  frac: 0.74, radiusFrac: 0.16, path: "\(outDir)/icon-16.png")
