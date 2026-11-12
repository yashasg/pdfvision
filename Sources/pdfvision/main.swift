import Foundation
import PDFMarkdown

private let version = "0.1.0"

private let usageText = """
pdfvision \(version) — Fast macOS PDF-to-Markdown converter (PDFKit + on-device Apple Vision OCR)

USAGE:
  pdfvision <input.pdf | -> [options]
  pdfvision <input.pdf | input.md | -> (--outline | --section <id>) [options]
  pdfvision --batch <input1.pdf> <input2.pdf> ... -o <output-directory> [options]

OPTIONS:
  -o, --output <path>       Write output to a file, or to this directory in batch mode
  --ocr <auto|always|disabled>
                            OCR mode (default: auto). 'disabled' exits 3 when pages need OCR
  --json                    Emit JSON with { markdown, pageCount, ocrPages, links, pages }
  --outline                 Emit a compact JSON heading outline
  --section <id>            Emit one heading section and its descendant subsections
  --from-markdown           Read saved Markdown instead of converting PDF (retrieval only)
  --batch                   Convert each positional input to one file in the output directory
  -v, --version             Print version
  -h, --help                Print help

EXIT CODES:
  0  Success
  1  Conversion error
  2  Usage error
  3  PDF requires OCR (when --ocr disabled)
"""

private struct Configuration {
    var inputPaths: [String] = []
    var outputPath: String?
    var ocrMode: PDFMarkdown.OCRMode = .automatic
    var emitJSON = false
    var isBatch = false
    var emitsOutline = false
    var sectionID: String?
    var readsMarkdown = false
}

private enum ContextSelection {
    case outline
    case section(String)
}

private struct SelectedSection: Encodable {
    let id: String
    let title: String
    let level: Int
    let markdown: String
}

private struct BatchItem {
    let inputPath: String
    let inputURL: URL
    let outputURL: URL
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("pdfvision: \(message)\n".utf8))
    exit(code)
}

private func parseArguments() -> Configuration {
    var configuration = Configuration()
    let arguments = Array(CommandLine.arguments.dropFirst())
    var parsesOptions = true
    var index = 0

    while index < arguments.count {
        let argument = arguments[index]
        if parsesOptions, argument == "--" {
            parsesOptions = false
        } else if parsesOptions {
            switch argument {
            case "-h", "--help":
                print(usageText)
                exit(0)
            case "-v", "--version":
                print(version)
                exit(0)
            case "--json":
                configuration.emitJSON = true
            case "--batch":
                configuration.isBatch = true
            case "--outline":
                configuration.emitsOutline = true
            case "--section":
                guard configuration.sectionID == nil else {
                    fail("--section may only be specified once", code: 2)
                }
                index += 1
                guard index < arguments.count,
                      !arguments[index].hasPrefix("-"),
                      !arguments[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else {
                    fail("missing value for --section", code: 2)
                }
                configuration.sectionID = arguments[index]
            case "--from-markdown":
                configuration.readsMarkdown = true
            case "-o", "--output":
                index += 1
                guard index < arguments.count else { fail("missing value for \(argument)", code: 2) }
                configuration.outputPath = arguments[index]
            case "--ocr":
                index += 1
                guard index < arguments.count,
                      let mode = PDFMarkdown.OCRMode(rawValue: arguments[index])
                else {
                    fail("invalid --ocr value (expected: auto, always, disabled)", code: 2)
                }
                configuration.ocrMode = mode
            default:
                if argument.hasPrefix("-"), argument != "-" {
                    fail("unknown option: \(argument)", code: 2)
                }
                configuration.inputPaths.append(argument)
            }
        } else {
            configuration.inputPaths.append(argument)
        }
        index += 1
    }

    return configuration
}

private func validateConfiguration(_ configuration: Configuration) {
    let retrievesContext = configuration.emitsOutline || configuration.sectionID != nil

    guard !(configuration.emitsOutline && configuration.sectionID != nil) else {
        fail("--outline and --section cannot be used together", code: 2)
    }
    guard !(retrievesContext && configuration.isBatch) else {
        fail("--outline and --section are not supported in batch mode", code: 2)
    }
    guard !configuration.readsMarkdown || retrievesContext else {
        fail("--from-markdown requires --outline or --section", code: 2)
    }
    if retrievesContext, let outputPath = configuration.outputPath {
        let output = canonicalPath(URL(fileURLWithPath: outputPath))
        if configuration.inputPaths.contains(where: {
            $0 != "-" && canonicalPath(URL(fileURLWithPath: $0)) == output
        }) {
            fail("context output would overwrite an input: \(outputPath)", code: 2)
        }
    }
}

private func contextSelection(_ configuration: Configuration) -> ContextSelection? {
    if configuration.emitsOutline {
        return .outline
    }
    return configuration.sectionID.map(ContextSelection.section)
}

private func encodedDocument(_ document: PDFMarkdown.Document, asJSON: Bool) throws -> Data {
    if asJSON {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(document) + Data("\n".utf8)
    }
    return Data(document.markdown.utf8)
}

private func compactJSON(_ value: some Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value) + Data("\n".utf8)
}

private func encodedContext(markdown: String, selection: ContextSelection, asJSON: Bool) throws -> Data {
    let context = MarkdownContext(markdown: markdown)

    switch selection {
    case .outline:
        return try compactJSON(context.outline)
    case let .section(id):
        let selectedMarkdown = try context.section(id: id)
        guard asJSON else {
            return Data(selectedMarkdown.utf8)
        }
        guard let entry = context.outline.first(where: { $0.id == id }) else {
            throw MarkdownContextError.unknownSection(id)
        }
        return try compactJSON(SelectedSection(
            id: entry.id,
            title: entry.title,
            level: entry.level,
            markdown: selectedMarkdown
        ))
    }
}

private func markdownInput(at inputPath: String) throws -> String {
    let data: Data = if inputPath == "-" {
        FileHandle.standardInput.readDataToEndOfFile()
    } else {
        try Data(contentsOf: URL(fileURLWithPath: inputPath), options: .mappedIfSafe)
    }
    guard let markdown = String(data: data, encoding: .utf8) else {
        throw NSError(
            domain: "pdfvision",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Markdown input is not valid UTF-8"]
        )
    }
    return markdown
}

private func extractedDocument(at inputPath: String, ocrMode: PDFMarkdown.OCRMode) throws -> PDFMarkdown.Document {
    if inputPath == "-" {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()
        return try PDFMarkdown.extract(data: stdinData, ocr: ocrMode)
    }
    return try PDFMarkdown.extract(at: URL(fileURLWithPath: inputPath), ocr: ocrMode)
}

private func canonicalPath(_ url: URL) -> String {
    url.standardizedFileURL.resolvingSymlinksInPath().path
        .precomposedStringWithCanonicalMapping.lowercased()
}

private func publishBatchOutput(_ data: Data, to outputURL: URL) throws {
    let fileManager = FileManager.default
    let temporaryURL = outputURL.deletingLastPathComponent()
        .appendingPathComponent(".pdfvision-\(UUID().uuidString).tmp")

    do {
        try data.write(to: temporaryURL, options: .withoutOverwriting)
        try fileManager.linkItem(at: temporaryURL, to: outputURL)
    } catch {
        let publishError = error
        do {
            try fileManager.removeItem(at: temporaryURL)
        } catch {
            let cleanupError = error as NSError
            if cleanupError.domain != NSCocoaErrorDomain || cleanupError.code != NSFileNoSuchFileError {
                let description = "\(publishError.localizedDescription); " +
                    "temporary file cleanup failed: \(error.localizedDescription)"
                throw NSError(
                    domain: "pdfvision",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: description]
                )
            }
        }
        throw publishError
    }

    try fileManager.removeItem(at: temporaryURL)
}

private func preflightBatch(_ configuration: Configuration) -> [BatchItem] {
    guard !configuration.inputPaths.isEmpty else {
        fail("batch mode requires at least one input file", code: 2)
    }
    guard !configuration.inputPaths.contains("-") else {
        fail("standard input is not supported in batch mode", code: 2)
    }
    guard let outputPath = configuration.outputPath else {
        fail("batch mode requires -o/--output <output-directory>", code: 2)
    }

    let outputDirectory = URL(fileURLWithPath: outputPath, isDirectory: true)
    var isDirectory: ObjCBool = false
    let outputExists = FileManager.default.fileExists(
        atPath: outputDirectory.path,
        isDirectory: &isDirectory
    )
    if outputExists, !isDirectory.boolValue {
        fail("batch output is not a directory: \(outputPath)", code: 2)
    }

    let inputURLs = configuration.inputPaths.map { URL(fileURLWithPath: $0).standardizedFileURL }
    let inputPaths = Set(inputURLs.map(canonicalPath))
    let outputExtension = configuration.emitJSON ? "json" : "md"
    var outputPaths: Set<String> = []
    var items: [BatchItem] = []

    for (inputPath, inputURL) in zip(configuration.inputPaths, inputURLs) {
        let baseName = inputURL.deletingPathExtension().lastPathComponent
        let outputURL = outputDirectory.appendingPathComponent(baseName).appendingPathExtension(outputExtension)
        let canonicalOutput = canonicalPath(outputURL)

        guard outputPaths.insert(canonicalOutput).inserted else {
            fail("multiple inputs map to the same output: \(outputURL.path)", code: 2)
        }
        guard !inputPaths.contains(canonicalOutput) else {
            fail("batch output would overwrite an input: \(outputURL.path)", code: 2)
        }
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            fail("batch output already exists: \(outputURL.path)", code: 2)
        }
        items.append(BatchItem(inputPath: inputPath, inputURL: inputURL, outputURL: outputURL))
    }

    if !outputExists {
        do {
            try FileManager.default.createDirectory(
                at: outputDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            fail("cannot create batch output directory \(outputPath): \(error.localizedDescription)", code: 2)
        }
    }

    return items
}

private func runSingle(_ configuration: Configuration) -> Never {
    guard let inputPath = configuration.inputPaths.first else {
        FileHandle.standardError.write(Data((usageText + "\n").utf8))
        exit(2)
    }
    guard configuration.inputPaths.count == 1 else {
        fail("unexpected extra argument: \(configuration.inputPaths[1])", code: 2)
    }

    do {
        let outputData: Data
        if let selection = contextSelection(configuration) {
            let markdown: String = if configuration.readsMarkdown {
                try markdownInput(at: inputPath)
            } else {
                try extractedDocument(at: inputPath, ocrMode: configuration.ocrMode).markdown
            }
            outputData = try encodedContext(
                markdown: markdown,
                selection: selection,
                asJSON: configuration.emitJSON
            )
        } else {
            let document = try extractedDocument(at: inputPath, ocrMode: configuration.ocrMode)
            outputData = try encodedDocument(document, asJSON: configuration.emitJSON)
        }

        if let outputPath = configuration.outputPath {
            try outputData.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        } else {
            FileHandle.standardOutput.write(outputData)
        }
        exit(0)
    } catch let error as MarkdownContextError {
        fail(error.localizedDescription, code: 2)
    } catch let error as PDFMarkdownError {
        if case .needsOCR = error {
            fail(error.localizedDescription, code: 3)
        }
        fail(error.localizedDescription, code: 1)
    } catch {
        fail(error.localizedDescription, code: 1)
    }
}

private func runBatch(_ configuration: Configuration) -> Never {
    let items = preflightBatch(configuration)
    var failureCount = 0
    var onlyOCRFailures = true

    for item in items {
        let result: Result<Void, Error> = autoreleasepool {
            Result {
                let document = try PDFMarkdown.extract(at: item.inputURL, ocr: configuration.ocrMode)
                let outputData = try encodedDocument(document, asJSON: configuration.emitJSON)
                try publishBatchOutput(outputData, to: item.outputURL)
            }
        }

        if case let .failure(error) = result {
            failureCount += 1
            if let pdfError = error as? PDFMarkdownError, case .needsOCR = pdfError {
                // This is the one failure class represented by exit code 3.
            } else {
                onlyOCRFailures = false
            }
            FileHandle.standardError.write(Data("pdfvision: \(item.inputPath): \(error.localizedDescription)\n".utf8))
        }
    }

    if failureCount == 0 {
        exit(0)
    }
    exit(onlyOCRFailures ? 3 : 1)
}

private let configuration = parseArguments()
validateConfiguration(configuration)
if configuration.isBatch {
    runBatch(configuration)
} else {
    runSingle(configuration)
}
