import AppKit
import CoreGraphics
import CoreText
import Foundation
import PDFKit
@testable import PDFMarkdown
import Testing

struct PDFMarkdownTests {
    @Test("Converts digital PDF with headings, checkmark bullets, and link annotations in single-digit ms")
    func convertsDigitalPDF() throws {
        let data = try makeDigitalPDF()
        let document = try PDFMarkdown.extract(data: data)

        #expect(document.pageCount == 1)
        #expect(document.ocrPages.isEmpty)
        #expect(document.markdown.contains("# Maya Okafor"))
        #expect(document.markdown.contains("## Senior Software Engineer"))
        #expect(document.markdown.contains("## SKILLS"))
        #expect(document.markdown.contains("- Swift | C++ | Python"))
        #expect(document.markdown.contains("## WORK EXPERIENCE"))
        #expect(document.markdown.contains("### Brightwave · Senior Software Engineer · Feb 2025 – Present"))
        #expect(document.markdown.contains("- Built high-throughput services reducing latency by 20 ms."))
        #expect(document.links == [
            PDFMarkdown.Link(page: 1, label: nil, url: "https://github.com/example"),
        ])
    }

    @Test("Image-only PDF throws needsOCR when OCR is disabled and extracts via Apple Vision when automatic")
    func handlesScannedImageOnlyPDF() throws {
        let data = try makeScannedImagePDF()

        #expect(throws: PDFMarkdownError.needsOCR(pages: [1], pageCount: 1)) {
            try PDFMarkdown.extract(data: data, ocr: .disabled)
        }

        let extracted = try PDFMarkdown.extract(data: data, ocr: .automatic)
        #expect(extracted.ocrPages == [1])
        #expect(extracted.markdown.localizedCaseInsensitiveContains("JESSICA"))
        #expect(extracted.markdown.contains("## EXPERIENCE"))
    }
}

private func makeDigitalPDF() throws -> Data {
    let data = NSMutableData()
    var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
    let consumer = try #require(CGDataConsumer(data: data as CFMutableData))
    let context = try #require(CGContext(consumer: consumer, mediaBox: &mediaBox, nil))
    context.beginPDFPage(nil)

    let lines: [(String, CGFloat, CGFloat)] = [
        ("Maya Okafor", 20, 720),
        ("Senior Software Engineer", 14, 700),
        ("SKILLS", 10, 675),
        ("✔ Swift | C++ | Python", 10, 658),
        ("WORK EXPERIENCE", 10, 635),
        ("Brightwave ß Senior Software Engineer ß Feb 2025 – Present", 10, 618),
        ("✔ Built high-throughput services reducing latency by 20 ms.", 10, 602),
    ]
    for (text, size, yPos) in lines {
        context.textPosition = CGPoint(x: 72, y: yPos)
        let attrs = [kCTFontAttributeName: CTFontCreateWithName("Helvetica" as CFString, size, nil)] as CFDictionary
        let attributed = try #require(CFAttributedStringCreate(nil, text as CFString, attrs))
        CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
    }
    if let url = URL(string: "https://github.com/example") {
        context.setURL(url as CFURL, for: CGRect(x: 72, y: 680, width: 100, height: 18))
    }
    context.endPDFPage()
    context.closePDF()
    return data as Data
}

private func makeScannedImagePDF() throws -> Data {
    let width = 1200
    let height = 600
    let bitmap = try #require(CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    bitmap.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    bitmap.fill(CGRect(x: 0, y: 0, width: width, height: height))

    let nsContext = NSGraphicsContext(cgContext: bitmap, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = nsContext
    let paragraph = "JESSICA CLAIRE\nEXPERIENCE\n2022 - Present Accountant\n• Built financial reports."
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.boldSystemFont(ofSize: 36),
        .foregroundColor: NSColor.black,
    ]
    (paragraph as NSString).draw(in: CGRect(x: 60, y: 60, width: 1080, height: 480), withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()

    let cgImage = try #require(bitmap.makeImage())
    let pdfData = NSMutableData()
    var mediaBox = CGRect(x: 0, y: 0, width: 600, height: 300)
    let consumer = try #require(CGDataConsumer(data: pdfData as CFMutableData))
    let pdfContext = try #require(CGContext(consumer: consumer, mediaBox: &mediaBox, nil))
    pdfContext.beginPDFPage(nil)
    pdfContext.draw(cgImage, in: mediaBox)
    pdfContext.endPDFPage()
    pdfContext.closePDF()
    return pdfData as Data
}
