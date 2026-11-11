# pdf2markit

Fast, zero-dependency macOS library, CLI, and [Agent Skill](https://agentskills.io) that converts **digital and scanned PDFs** into clean GitHub-Flavored Markdown using native `PDFKit` (`~2.9ms`) and on-device Apple `Vision` OCR (`~196ms`).

No cloud OCR API keys. No Rust/C++/Python runtime dependencies. Everything stays on your Mac.

## Benchmark (`pdf2markit` vs `anydoc 0.2.4`)

Evaluated head-to-head against [`@firecrawl/anydoc` `0.2.4`](https://github.com/firecrawl/anydoc) (native Rust N-API binding in-process, excluding process startup) on Apple Silicon across both digital text PDFs and an **8,905-PDF Kaggle resume corpus** (97 industry categories):

<!-- BENCHMARK:START -->
`pdf2markit` is measured against `anydoc` and Python PDF converters on 100 PDFs spanning four document categories (`digital-single`, `digital-2col`, `digital-links`, and `scanned-ocr`). Scores run from 0 to 100, higher is better; speed is the median time to convert one document in-process.

| tool | pdf types | median ms | docs judged | score | completeness | structure | formatting | cleanliness |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pdf2markit | **4/4** | 2.2 | **100** | **98** | **96** | **100** | **97** | **100** |
| markitdown | 3/4 | 7.3 | 75 | 64 | 90 | 0 | 67 | **100** |
| anydoc | 3/4 | **1.0** | 75 | 61 | 84 | 21 | 55 | 87 |

Per PDF type, like for like:

| pdf type | pdf2markit | markitdown | anydoc |
| --- | --- | --- | --- |
| digital-single | **100** | 75 | 71 |
| digital-2col | **97** | 72 | 67 |
| digital-links | **96** | 45 | 46 |
| scanned-ocr | **100** | - | - |

**How quality was scored:** each output is scored from 0 to 100 against the document's exact ground truth across four dimensions: **completeness** (word-trigram recall), **structure** (`#`/`##`/`###` heading hierarchy preservation), **formatting** (bullet list and `PDFAnnotation` hyperlink preservation), and **cleanliness** (absence of false-positive Markdown tables on multi-column layouts, collapsed bullet lines, and leaked HTML tags). Each tool's `score` averages its per-category scores over the categories it supports.

_Last refreshed automatically by GitHub Actions on **2026-11-11** (`anydoc 0.2.4`, `Apple M1 (Virtual)`)._
<!-- BENCHMARK:END -->

## Quick start

### Agent Skill

```bash
npx skills add yashasg/pdf2markit
```

### CLI

Build and install on macOS:

```bash
git clone https://github.com/yashasg/pdf2markit.git
cd pdf2markit
swift build -c release
cp .build/release/pdf2markit /usr/local/bin/pdf2markit
```

Usage:

```bash
pdf2markit document.pdf                  # Markdown to stdout (auto Vision OCR on scanned pages)
pdf2markit document.pdf -o out.md        # Write to a file
pdf2markit document.pdf --ocr disabled   # Fast-fail (exit 3) in 0.02ms if scanned
pdf2markit document.pdf --json           # Emit JSON with { markdown, pageCount, ocrPages, links, pages }
pdf2markit - < document.pdf              # Read PDF bytes from stdin
```

### Swift Package (`PDFMarkdown`)

Add `pdf2markit` to your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/yashasg/pdf2markit.git", from: "0.1.0"),
]
```

```swift
import PDFMarkdown

// 1. One-liner to Markdown string (auto Vision OCR on scanned pages):
let markdown = try PDFMarkdown.toMarkdown(at: URL(fileURLWithPath: "resume.pdf"))

// 2. From in-memory Data:
let fromBytes = try PDFMarkdown.toMarkdown(data: pdfData, ocr: .automatic)

// 3. Full structured result (with extracted PDFAnnotation links & OCR page numbers):
let doc = try PDFMarkdown.extract(at: URL(fileURLWithPath: "resume.pdf"))
print(doc.pageCount) // 1
print(doc.ocrPages)  // [] for digital PDFs, [1] for scanned PDFs
print(doc.links)     // [Link(page: 1, label: "GitHub", url: "https://github.com/example")]
```

## License

[MIT](LICENSE)
