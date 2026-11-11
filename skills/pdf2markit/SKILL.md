---
name: pdf2markit
description: Convert digital and scanned PDF files to clean GitHub-Flavored Markdown on macOS using native PDFKit (~2.9ms) and on-device Apple Vision OCR (~196ms) with zero cloud calls. Use whenever a task needs the contents, headings, bullets, or hyperlink targets of a PDF file.
license: MIT
metadata:
  author: yashasg
  platform: macos
---

# Convert PDFs to Markdown (`pdf2markit`)

Convert any local PDF (digital or scanned) into clean GitHub-Flavored Markdown on macOS using native `PDFKit` + on-device Apple `Vision` OCR.

## Quick start

```bash
# If pdf2markit is installed on PATH:
pdf2markit document.pdf                  # Markdown to stdout (auto Vision OCR on scanned pages)
pdf2markit document.pdf -o out.md        # Write Markdown to a file
pdf2markit document.pdf --json           # JSON with { markdown, pageCount, ocrPages, links, pages }
pdf2markit document.pdf --ocr disabled   # Fast-fail (exit 3) in 0.02ms if any page is scanned
pdf2markit - < document.pdf              # Read PDF bytes from stdin
```

If `pdf2markit` is not yet installed on `PATH`, install it once with:

```bash
git clone https://github.com/yashasg/pdf2markit.git /tmp/pdf2markit && \
  swift build -c release --package-path /tmp/pdf2markit && \
  cp /tmp/pdf2markit/.build/release/pdf2markit /usr/local/bin/pdf2markit
```

## Rules

1. **Zero network calls:** `pdf2markit` runs 100% locally on macOS. Digital pages extract in `~2.9ms` via `PDFKit`; scanned/image-only pages automatically fall back to on-device Apple `Vision` (`VNRecognizeTextRequest(.accurate)`) in `~196ms/page`.
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
