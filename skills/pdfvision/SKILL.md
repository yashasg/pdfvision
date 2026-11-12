---
name: pdfvision
description: Convert digital and scanned PDFs to Markdown on macOS, inspect a compact outline, and retrieve only needed sections to limit agent context. Uses PDFKit, on-device Vision OCR, and swift-markdown.
license: MIT
metadata:
  author: yashasg
  platform: macos
---

# Convert PDFs to Markdown (`pdfvision`)

Convert any local PDF (digital or scanned) into clean GitHub-Flavored Markdown on macOS using native `PDFKit` + on-device Apple `Vision` OCR.

## Quick start

```bash
# If pdfvision is installed on PATH:
pdfvision document.pdf                  # Markdown to stdout (auto Vision OCR on scanned pages)
pdfvision document.pdf -o out.md         # Write Markdown to a file
pdfvision document.pdf --json            # JSON with { markdown, pageCount, ocrPages, links, pages }
pdfvision document.pdf --ocr disabled    # Exit 3 if any page needs OCR
pdfvision - < document.pdf               # Read PDF bytes from stdin
pdfvision --batch documents/*.pdf -o markdown/
```

For questions about a document, convert once and retrieve only relevant sections:

```bash
pdfvision report.pdf -o report.md
pdfvision report.md --from-markdown --outline
pdfvision report.md --from-markdown --section s2
```

Choose section IDs from the outline rather than guessing. The outline contains IDs, titles, and heading levels only. A selected section includes its descendants but not sibling sections; `--json` returns only that section's metadata and Markdown. Use `s0` for the preamble or headingless document when listed. IDs apply only to the same unchanged input. Query the saved Markdown to avoid repeating OCR, and do not load the entire Markdown or AST into context first.

If `pdfvision` is not yet installed on `PATH`, install it once with:

```bash
git clone https://github.com/yashasg/pdfvision.git /tmp/pdfvision && \
  swift build -c release --package-path /tmp/pdfvision && \
  cp /tmp/pdfvision/.build/release/pdfvision /usr/local/bin/pdfvision
```

## Rules

1. **Local conversion:** `pdfvision` uses PDFKit for digital pages and on-device Apple Vision OCR for scanned pages. Search the resulting Markdown and load only relevant passages into context; do not assume a fixed token saving.
2. **Exit codes:**
   - `0`: Success
   - `1`: Unreadable, encrypted, malformed, or empty PDF
   - `2`: CLI usage error
   - `3`: One or more pages require OCR (only when `--ocr disabled` is passed)
3. **Hyperlinks:** When a PDF contains invisible link annotations (`mailto:`, `https://`), pass `--json` to inspect the `links` array (`{ page, label, url }`).
4. **Swift projects:** Inside a Swift codebase on macOS, import the `PDFMarkdown` library product directly instead of shelling out:
   ```swift
   import PDFMarkdown
   let markdown = try PDFMarkdown.toMarkdown(at: pdfURL)
   ```
5. **Batch conversion:** `--batch` requires an output directory, writes one file per input, and refuses existing outputs or duplicate names. A failed file is reported on stderr without stopping other conversions; any failure gives a nonzero exit.
6. **Selective context:** `--outline` and `--section` are mutually exclusive single-input queries, not batch options. `--from-markdown` reads existing Markdown, including stdin, and requires one of those queries. Unknown section IDs fail explicitly; inspect the outline again instead of falling back to the full document.
