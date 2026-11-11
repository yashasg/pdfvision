import Foundation
import PDFMarkdown

private let version = "0.1.0"

private let usageText = """
pdf2markit \(version) — Fast macOS PDF-to-Markdown converter (PDFKit + on-device Apple Vision OCR)

USAGE:
  pdf2markit <input.pdf | -> [options]

OPTIONS:
  -o, --output <path>       Write output to a file instead of stdout
  --ocr <auto|always|disabled>
                            OCR mode (default: auto). 'disabled' exits 3 when pages need OCR
  --json                    Emit JSON with { markdown, pageCount, ocrPages, links, pages }
  -v, --version             Print version
  -h, --help                Print help

EXIT CODES:
  0  Success
  1  Conversion error
  2  Usage error
  3  PDF requires OCR (when --ocr disabled)
"""

private func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("pdf2markit: \(message)\n".utf8))
    exit(code)
}

var inputPath: String?
var outputPath: String?
var ocrMode: PDFMarkdown.OCRMode = .automatic
var emitJSON = false

var args = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < args.count {
    let arg = args[index]
    switch arg {
    case "-h", "--help":
        print(usageText)
        exit(0)
    case "-v", "--version":
        print(version)
        exit(0)
    case "--json":
        emitJSON = true
    case "-o", "--output":
        index += 1
        guard index < args.count else { fail("missing value for \(arg)", code: 2) }
        outputPath = args[index]
    case "--ocr":
        index += 1
        guard index < args.count, let mode = PDFMarkdown.OCRMode(rawValue: args[index]) else {
            fail("invalid --ocr value (expected: auto, always, disabled)", code: 2)
        }
        ocrMode = mode
    default:
        if arg.hasPrefix("-"), arg != "-" {
            fail("unknown option: \(arg)", code: 2)
        }
        if inputPath != nil {
            fail("unexpected extra argument: \(arg)", code: 2)
        }
        inputPath = arg
    }
    index += 1
}

guard let inputPath else {
    FileHandle.standardError.write(Data((usageText + "\n").utf8))
    exit(2)
}

do {
    let document: PDFMarkdown.Document
    if inputPath == "-" {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()
        document = try PDFMarkdown.extract(data: stdinData, ocr: ocrMode)
    } else {
        let url = URL(fileURLWithPath: inputPath)
        document = try PDFMarkdown.extract(at: url, ocr: ocrMode)
    }

    let outputData: Data
    if emitJSON {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        outputData = try encoder.encode(document) + Data("\n".utf8)
    } else {
        outputData = Data(document.markdown.utf8)
    }

    if let outputPath {
        try outputData.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    } else {
        FileHandle.standardOutput.write(outputData)
    }
} catch let error as PDFMarkdownError {
    if case .needsOCR = error {
        fail(error.localizedDescription, code: 3)
    }
    fail(error.localizedDescription, code: 1)
} catch {
    fail(error.localizedDescription, code: 1)
}
