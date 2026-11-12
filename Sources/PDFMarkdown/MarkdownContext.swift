import Foundation
import Markdown

public enum MarkdownContextError: Error, Equatable, LocalizedError, Sendable {
    case unknownSection(String)

    public var errorDescription: String? {
        switch self {
        case let .unknownSection(id):
            "unknown section: \(id); use --outline to list section IDs"
        }
    }
}

public struct MarkdownContext {
    public struct Entry: Codable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let level: Int
    }

    public let outline: [Entry]
    private let blocks: [any BlockMarkup]
    private let ranges: [Range<Int>]

    public init(markdown: String) {
        let blocks = Array(Markdown.Document(parsing: markdown).blockChildren)
        var entries: [Entry] = []
        var starts: [Int] = []
        var headingCount = 0

        for (index, block) in blocks.enumerated() {
            if let heading = block as? Heading {
                headingCount += 1
                entries.append(Entry(id: "s\(headingCount)", title: heading.plainText, level: heading.level))
                starts.append(index)
            } else if index == 0 {
                entries.append(Entry(id: "s0", title: "Preamble", level: 0))
                starts.append(0)
            }
        }
        if headingCount == 0, !entries.isEmpty {
            entries[0] = Entry(id: "s0", title: "Document", level: 0)
        }

        var ends = Array(repeating: blocks.count, count: entries.count)
        var openHeadings: [Int] = []
        for index in entries.indices where entries[index].level > 0 {
            while let previous = openHeadings.last, entries[previous].level >= entries[index].level {
                ends[previous] = starts[index]
                openHeadings.removeLast()
            }
            openHeadings.append(index)
        }
        if entries.first?.level == 0, entries.count > 1 {
            ends[0] = starts[1]
        }

        self.blocks = blocks
        outline = entries
        ranges = zip(starts, ends).map { $0 ..< $1 }
    }

    public func section(id: String) throws -> String {
        guard let index = outline.firstIndex(where: { $0.id == id }) else {
            throw MarkdownContextError.unknownSection(id)
        }
        let selected = Markdown.Document(blocks[ranges[index]])
        var escaper = LiteralTextEscaper()
        return escaper.visit(selected).format().trimmingCharacters(in: .newlines) + "\n"
    }
}

private struct LiteralTextEscaper: MarkupVisitor {
    mutating func defaultVisit(_ markup: any Markup) -> any Markup {
        markup.withUncheckedChildren(markup.children.map { visit($0) })
    }

    mutating func visitText(_ text: Text) -> any Markup {
        // The formatter emits Text verbatim; escape literal ASCII punctuation for Markdown.
        Text(text.string.replacingOccurrences(
            of: #"([!-/:-@\[-`{-~])"#,
            with: #"\\$1"#,
            options: .regularExpression
        ))
    }
}
