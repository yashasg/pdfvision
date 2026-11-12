import Foundation
@testable import PDFMarkdown
import Testing

struct MarkdownContextTests {
    @Test("Sections include descendants, exclude siblings, and retain a separate preamble")
    func selectsHeadingSubtrees() throws {
        let context = MarkdownContext(markdown: """
        Preamble text.

        # Report
        Report introduction.

        ## Details
        Detail text.

        ### Evidence
        Nested evidence.

        ## Results
        Result text.

        # Appendix
        Appendix text.
        """)
        #expect(context.outline.map(\.id) == ["s0", "s1", "s2", "s3", "s4", "s5"])
        #expect(context.outline.map(\.level) == [0, 1, 2, 3, 2, 1])
        #expect(try context.section(id: "s0") == "Preamble text\\.\n")
        let details = try context.section(id: "s2")
        #expect(details.contains("Detail text"))
        #expect(details.contains("Nested evidence"))
        #expect(!details.contains("Preamble text"))
        #expect(!details.contains("Result text"))
        #expect(!details.contains("Appendix text"))
        let report = try context.section(id: "s1")
        #expect(report.contains("Result text"))
        #expect(!report.contains("Appendix text"))
    }

    @Test("AST headings handle duplicate titles, inline markup, setext headings, and code blocks")
    func usesParsedHeadings() throws {
        let context = MarkdownContext(markdown: """
        # **Résumé** `2026`

        ```markdown
        # Not a section
        ```

        > # A quoted heading

        Repeated
        --------

        First repeated body.

        ## Repeated
        Second repeated body.
        """)
        #expect(context.outline.map(\.title) == ["Résumé `2026`", "Repeated", "Repeated"])
        #expect(context.outline.map(\.id) == ["s1", "s2", "s3"])
        let first = try context.section(id: "s2")
        #expect(first.contains("First repeated body"))
        #expect(!first.contains("Second repeated body"))
        #expect(try context.section(id: "s3").contains("Second repeated body"))
        #expect(try context.section(id: "s1").contains("# Not a section"))
    }

    @Test("Selected output retains lists, tables, code, and resolved reference links")
    func preservesSelectedStructure() throws {
        let context = MarkdownContext(markdown: """
        # Selected

        - First item
        - Second item

        | Name | Value |
        | --- | --- |
        | Alpha | 7 |

        ```swift
        let value = 7
        ```

        Read [the reference][source].

        # Other

        Unrelated content.

        [source]: https://example.com/reference
        """)
        let selected = try context.section(id: "s1")
        #expect(selected.contains("First item"))
        #expect(selected.contains("Second item"))
        #expect(selected.contains("|"))
        #expect(selected.contains("Alpha"))
        #expect(selected.contains("let value = 7"))
        #expect(selected.contains("https://example.com/reference"))
        #expect(!selected.contains("Unrelated content"))
    }

    @Test("Literal punctuation cannot become headings, lists, emphasis, links, or HTML")
    func preservesLiteralPunctuation() throws {
        let context = MarkdownContext(markdown: ##"""
        # Selected

        \# Literal heading

        \*literal stars\* and \[brackets\] and \<tag\>.

        1\. Not an ordered list.

        \- Not a bullet.

        # Other

        Excluded content.
        """##)
        let selected = try context.section(id: "s1")
        #expect(selected.contains(##"\# Literal heading"##))
        #expect(selected.contains(#"\*literal stars\*"#))
        #expect(selected.contains(#"\[brackets\]"#))
        #expect(selected.contains(#"\<tag\>"#))
        #expect(selected.contains(#"1\. Not an ordered list"#))
        #expect(selected.contains(#"\- Not a bullet"#))
        #expect(!selected.contains("Excluded content"))
        #expect(MarkdownContext(markdown: selected).outline.map(\.title) == ["Selected"])
    }

    @Test("Headingless documents remain addressable and missing IDs never return the whole document")
    func handlesMissingHeadingsAndIDs() throws {
        let context = MarkdownContext(markdown: "An ordinary paragraph.\n\nAnother paragraph.")
        #expect(context.outline.map(\.id) == ["s0"])
        #expect(context.outline.first?.title == "Document")
        #expect(try context.section(id: "s0").contains("Another paragraph"))
        #expect(throws: MarkdownContextError.unknownSection("s9")) {
            try context.section(id: "s9")
        }
        let empty = MarkdownContext(markdown: " \n\n")
        #expect(empty.outline.isEmpty)
        #expect(throws: MarkdownContextError.unknownSection("s0")) {
            try empty.section(id: "s0")
        }
    }
}
