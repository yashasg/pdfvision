import CoreGraphics
import Foundation
import PDFKit
import Vision

public enum PDFMarkdownError: Error, Equatable, LocalizedError, Sendable {
    case unreadableFile(String)
    case emptyDocument
    case encrypted
    case malformed
    case needsOCR(pages: [Int], pageCount: Int)
    case noExtractableText(pageCount: Int)

    public var errorDescription: String? {
        switch self {
        case let .unreadableFile(path):
            "could not read file: \(path)"
        case .emptyDocument:
            "PDF has 0 pages"
        case .encrypted:
            "PDF is encrypted or password-protected"
        case .malformed:
            "invalid or corrupted PDF document"
        case let .needsOCR(pages, pageCount):
            "pages \(pages.map(String.init).joined(separator: ", ")) of \(pageCount) need OCR"
        case let .noExtractableText(pageCount):
            "PDF has no extractable text (\(pageCount) pages)"
        }
    }
}

public enum PDFMarkdown {
    public enum OCRMode: String, Codable, Sendable, CaseIterable {
        /// Read embedded PDFKit text stream first (~0.04ms/page); fall back to on-device Apple Vision OCR only on pages without selectable text.
        case automatic = "auto"
        /// Force on-device Apple Vision OCR on every page.
        case always
        /// Never run OCR; throw `PDFMarkdownError.needsOCR` if any page has no selectable text (~0.02ms check).
        case disabled
    }

    public struct Link: Codable, Equatable, Sendable {
        public let page: Int
        public let label: String?
        public let url: String

        public init(page: Int, label: String?, url: String) {
            self.page = page
            self.label = label
            self.url = url
        }
    }

    public struct Page: Codable, Equatable, Sendable {
        public let pageNumber: Int
        public let markdown: String
        public let usedOCR: Bool
        public let links: [Link]

        public init(pageNumber: Int, markdown: String, usedOCR: Bool, links: [Link]) {
            self.pageNumber = pageNumber
            self.markdown = markdown
            self.usedOCR = usedOCR
            self.links = links
        }
    }

    public struct Document: Codable, Equatable, Sendable {
        public let markdown: String
        public let pageCount: Int
        public let ocrPages: [Int]
        public let links: [Link]
        public let pages: [Page]

        public init(
            markdown: String,
            pageCount: Int,
            ocrPages: [Int],
            links: [Link],
            pages: [Page]
        ) {
            self.markdown = markdown
            self.pageCount = pageCount
            self.ocrPages = ocrPages
            self.links = links
            self.pages = pages
        }
    }

    /// Convert a PDF file at `url` to GitHub-Flavored Markdown.
    public static func toMarkdown(at url: URL, ocr: OCRMode = .automatic) throws -> String {
        try extract(at: url, ocr: ocr).markdown
    }

    /// Convert in-memory PDF bytes to GitHub-Flavored Markdown.
    public static func toMarkdown(data: Data, ocr: OCRMode = .automatic) throws -> String {
        try extract(data: data, ocr: ocr).markdown
    }

    /// Extract Markdown, page metadata, OCR page indices, and hyperlink annotations from a PDF file.
    public static func extract(at url: URL, ocr: OCRMode = .automatic) throws -> Document {
        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw PDFMarkdownError.unreadableFile(url.path)
        }
        return try extract(data: data, ocr: ocr)
    }

    /// Extract Markdown, page metadata, OCR page indices, and hyperlink annotations from in-memory PDF bytes.
    public static func extract(data: Data, ocr: OCRMode = .automatic) throws -> Document {
        guard !data.isEmpty, let pdf = PDFDocument(data: data) else {
            throw PDFMarkdownError.malformed
        }
        if pdf.isLocked {
            throw PDFMarkdownError.encrypted
        }
        let pageCount = pdf.pageCount
        guard pageCount > 0 else {
            throw PDFMarkdownError.emptyDocument
        }

        var pages: [Page] = []
        pages.reserveCapacity(pageCount)
        var ocrPages: [Int] = []
        var allLinks: [Link] = []
        var missingTextPages: [Int] = []

        for index in 0 ..< pageCount {
            let pageNumber = index + 1
            guard let page = pdf.page(at: index) else {
                throw PDFMarkdownError.malformed
            }
            let pageLinks = extractLinks(on: page, pageNumber: pageNumber)
            allLinks.append(contentsOf: pageLinks)

            let directText = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawText: String
            let usedOCR: Bool

            switch ocr {
            case .always:
                rawText = recognizeText(on: page)
                usedOCR = true
                ocrPages.append(pageNumber)
            case .automatic:
                if directText.isEmpty {
                    rawText = recognizeText(on: page)
                    usedOCR = !rawText.isEmpty
                    if usedOCR {
                        ocrPages.append(pageNumber)
                    }
                } else {
                    rawText = directText
                    usedOCR = false
                }
            case .disabled:
                if directText.isEmpty {
                    missingTextPages.append(pageNumber)
                }
                rawText = directText
                usedOCR = false
            }

            let md = markdown(from: rawText)
            if !md.isEmpty || !pageLinks.isEmpty {
                pages.append(Page(
                    pageNumber: pageNumber,
                    markdown: md,
                    usedOCR: usedOCR,
                    links: pageLinks
                ))
            }
        }

        if ocr == .disabled, !missingTextPages.isEmpty {
            throw PDFMarkdownError.needsOCR(pages: missingTextPages, pageCount: pageCount)
        }

        var combined = pages.map(\.markdown).filter { !$0.isEmpty }.joined(separator: "\n\n")
        guard !combined.isEmpty else {
            throw PDFMarkdownError.noExtractableText(pageCount: pageCount)
        }
        if !combined.hasSuffix("\n") {
            combined.append("\n")
        }

        return Document(
            markdown: combined,
            pageCount: pageCount,
            ocrPages: ocrPages,
            links: allLinks,
            pages: pages
        )
    }

    /// Format extracted page text into structured Markdown (`#`, `##`, `###`, `- `).
    public static func markdown(from rawText: String) -> String {
        guard !rawText.isEmpty else { return "" }
        var output: [String] = []
        output.reserveCapacity(64)
        var inStructuredSection = false
        var headerLineCount = 0

        rawText.enumerateLines { rawLine, _ in
            let line = rawLine
                .replacingOccurrences(of: " ß ", with: " · ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { return }

            if let first = line.first, bulletCharacters.contains(first) {
                let item = line.drop { bulletCharacters.contains($0) || $0.isWhitespace }
                if !item.isEmpty {
                    output.append("- \(item)")
                }
                return
            }
            if isSectionHeading(line) {
                inStructuredSection = true
                let title = line.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
                output.append("## \(title)")
                return
            }
            if !inStructuredSection {
                headerLineCount += 1
                if headerLineCount == 1, line.count <= 48, !line.contains("@"), !line.contains("—") {
                    output.append("# \(line)")
                } else if headerLineCount == 2, line.count <= 60, !line.contains("@"), !line.contains("|") {
                    output.append("## \(line)")
                } else {
                    output.append(line)
                }
                return
            }
            output.append(isEntryHeader(line) ? "### \(line)" : line)
        }
        return output.joined(separator: "\n")
    }
}

private extension PDFMarkdown {
    static let bulletCharacters: Set<Character> = [
        "•", "●", "○", "◦", "▪", "▫", "✔", "✓", "➢", "➣", "➤", "‣", "-", "*",
    ]

    static let sectionNames: Set<String> = [
        "contact", "contact information", "personal information",
        "summary", "professional summary", "profile", "objective", "career objective", "highlights", "about me",
        "experience", "work experience", "professional experience", "employment", "employment history",
        "education", "academic background", "academic qualifications",
        "skills", "technical skills", "core skills", "core competencies", "skills and technologies",
        "projects", "personal projects", "selected projects", "school projects", "academic projects",
        "certifications", "certificates", "licenses", "certifications and licenses",
        "publications", "awards", "honors", "references", "languages",
    ]

    static let entryDateRegex = try? NSRegularExpression(
        pattern: #"\b(?:19|20)\d{2}\b|Present|Current"#,
        options: [.caseInsensitive]
    )

    static func isSectionHeading(_ line: String) -> Bool {
        guard line.count <= 48, line.contains(where: \.isLetter) else { return false }
        let key = line
            .trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .lowercased()
        if sectionNames.contains(key) {
            return true
        }
        return line == line.uppercased() && !line.contains("|") && !line.contains("@") && line.count <= 32
    }

    static func isEntryHeader(_ line: String) -> Bool {
        guard line.count <= 96, !line.lowercased().hasPrefix("tools:") else { return false }
        let range = NSRange(line.startIndex..., in: line)
        return entryDateRegex?.firstMatch(in: line, range: range) != nil
    }

    static func extractLinks(on page: PDFPage, pageNumber: Int) -> [Link] {
        var seen = Set<String>()
        return page.annotations.compactMap { annotation in
            guard let url = annotation.url ?? (annotation.action as? PDFActionURL)?.url else {
                return nil
            }
            let value = url.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, seen.insert(value.lowercased()).inserted else {
                return nil
            }
            let label = page.selection(for: annotation.bounds)?
                .string?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Link(
                page: pageNumber,
                label: (label?.isEmpty == false) ? label : nil,
                url: value
            )
        }
    }

    static func recognizeText(on page: PDFPage) -> String {
        let rect = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0
        let width = max(1, Int(rect.width * scale))
        let height = max(1, Int(rect.height * scale))
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        else {
            return ""
        }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: context)
        guard let cgImage = context.makeImage() else { return "" }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try? VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
        return (request.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }
}
