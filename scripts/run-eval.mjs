#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  renderBenchmarkChart,
  renderBenchmarkSection,
  replaceBenchmarkSection,
  summarizeExternalCompletion,
  summarizeSyntheticQuality,
  validateExternalManifest,
} from './eval-metrics.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

export function buildSwiftGeneratorSource(pdfMarkdownSource) {
  return `${pdfMarkdownSource}
import CoreText

@main
struct CorpusRunner {
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        var manifest: [[String: Any]] = []

        for index in 0..<25 {
            let singleColumn = directory.appendingPathComponent("digital-single_\\(index).pdf")
            try makeSingleColumn(at: singleColumn, index: index)
            manifest.append([
                "id": "digital-single_\\(index)",
                "category": "digital-single",
                "path": singleColumn.path,
                "corpus": "synthetic",
                "groundTruth": singleColumnTruth(index: index),
                "expectedHeadings": 7,
                "expectedBullets": 6,
                "expectedLinks": [] as [String],
            ])

            let twoColumn = directory.appendingPathComponent("digital-2col_\\(index).pdf")
            try makeTwoColumn(at: twoColumn, index: index)
            manifest.append([
                "id": "digital-2col_\\(index)",
                "category": "digital-2col",
                "path": twoColumn.path,
                "corpus": "synthetic",
                "groundTruth": twoColumnTruth(index: index),
                "expectedHeadings": 6,
                "expectedBullets": 6,
                "expectedLinks": [] as [String],
            ])

            let links = directory.appendingPathComponent("digital-links_\\(index).pdf")
            try makeDigitalLinks(at: links, index: index)
            manifest.append([
                "id": "digital-links_\\(index)",
                "category": "digital-links",
                "path": links.path,
                "corpus": "synthetic",
                "groundTruth": digitalLinksTruth(index: index),
                "expectedHeadings": 7,
                "expectedBullets": 6,
                "expectedLinks": [
                    "https://github.com/example",
                    "https://linkedin.com/in/example",
                ],
            ])
        }

        if CommandLine.arguments.count > 2 {
            let externalData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
            guard
                let payload = try JSONSerialization.jsonObject(with: externalData) as? [String: Any],
                let documents = payload["documents"] as? [[String: Any]]
            else {
                throw NSError(
                    domain: "CorpusRunner",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "invalid external corpus manifest"]
                )
            }
            for document in documents {
                guard
                    let id = document["id"] as? String,
                    let category = document["category"] as? String,
                    let documentPath = document["path"] as? String
                else {
                    throw NSError(
                        domain: "CorpusRunner",
                        code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "invalid external corpus document"]
                    )
                }
                manifest.append([
                    "id": id,
                    "category": category,
                    "path": documentPath,
                    "corpus": "external",
                ])
            }
        }

        var results: [[String: Any]] = []
        results.reserveCapacity(manifest.count)
        for item in manifest {
            let result: [String: Any] = autoreleasepool {
                let id = item["id"] as! String
                let category = item["category"] as! String
                let corpus = item["corpus"] as! String
                let started = ContinuousClock.now
                do {
                    let url = URL(fileURLWithPath: item["path"] as! String)
                    let document = try PDFMarkdown.extract(at: url, ocr: .disabled)
                    let milliseconds = elapsedMilliseconds(since: started)
                    guard !document.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        return [
                            "id": id,
                            "category": category,
                            "corpus": corpus,
                            "ms": milliseconds,
                            "success": false,
                            "outputNonEmpty": false,
                            "error": "empty output",
                        ]
                    }

                    var record: [String: Any] = [
                        "id": id,
                        "category": category,
                        "corpus": corpus,
                        "ms": milliseconds,
                        "success": true,
                        "outputNonEmpty": true,
                    ]
                    if corpus == "synthetic" {
                        record["markdown"] = document.markdown
                        record["links"] = document.links.map(\\.url)
                    }
                    return record
                } catch {
                    return [
                        "id": id,
                        "category": category,
                        "corpus": corpus,
                        "ms": elapsedMilliseconds(since: started),
                        "success": false,
                        "outputNonEmpty": false,
                        "error": String(String(describing: error).prefix(500)),
                    ]
                }
            }
            results.append(result)
        }

        let payload: [String: Any] = ["manifest": manifest, "pdfvision": results]
        let output = try JSONSerialization.data(withJSONObject: payload)
        try output.write(to: directory.appendingPathComponent("swift_out.json"))
    }

    static func elapsedMilliseconds(since started: ContinuousClock.Instant) -> Double {
        let duration = started.duration(to: .now)
        return Double(duration.components.seconds) * 1_000.0
            + Double(duration.components.attoseconds) / 1e15
    }

    static func singleColumnTruth(index: Int) -> String {
        """
        Maya Okafor \\(index)
        Senior Software Engineer
        SUMMARY
        Backend engineer building distributed cloud services and developer tooling.
        WORK EXPERIENCE
        Brightwave Senior Software Engineer 2022 - Present
        Built fault-tolerant payment microservices handling 50,000 requests per minute.
        Reduced distributed API p99 latency by 35% across 4 core services.
        Kettle Software Engineer 2019 - 2022
        Automated CI/CD deployment pipelines for 12 engineering teams.
        SKILLS
        Swift, Go, PostgreSQL
        Kubernetes, AWS, Terraform
        Observability, OpenTelemetry
        EDUCATION
        UC Berkeley B.S. in Computer Science 2019
        """
    }

    static func makeSingleColumn(at url: URL, index: Int) throws {
        let data = NSMutableData()
        var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)!
        context.beginPDFPage(nil)
        let lines: [(String, CGFloat, CGFloat)] = [
            ("Maya Okafor \\(index)", 20, 732),
            ("Senior Software Engineer", 14, 712),
            ("SUMMARY", 11, 686),
            ("Backend engineer building distributed cloud services and developer tooling.", 10, 670),
            ("WORK EXPERIENCE", 11, 644),
            ("Brightwave Senior Software Engineer 2022 - Present", 10.5, 626),
            ("• Built fault-tolerant payment microservices handling 50,000 requests per minute.", 10, 610),
            ("• Reduced distributed API p99 latency by 35% across 4 core services.", 10, 594),
            ("Kettle Software Engineer 2019 - 2022", 10.5, 572),
            ("• Automated CI/CD deployment pipelines for 12 engineering teams.", 10, 556),
            ("SKILLS", 11, 530),
            ("• Swift, Go, PostgreSQL", 10, 514),
            ("• Kubernetes, AWS, Terraform", 10, 498),
            ("• Observability, OpenTelemetry", 10, 482),
            ("EDUCATION", 11, 456),
            ("UC Berkeley B.S. in Computer Science 2019", 10.5, 440),
        ]
        for (text, size, y) in lines {
            draw(text, in: context, x: 56, y: y, size: size)
        }
        context.endPDFPage()
        context.closePDF()
        try (data as Data).write(to: url)
    }

    static func twoColumnTruth(index: Int) -> String {
        """
        Alex Rivera \\(index)
        Staff Platform Engineer
        EXPERIENCE
        Brightwave Staff Engineer 2021 - Present
        Architected multi-region service mesh across 3 cloud clusters.
        Lowered infrastructure compute spend by 28%.
        SKILLS
        Rust
        Swift
        Kubernetes
        Linux
        EDUCATION
        MIT B.S. Computer Science 2018
        """
    }

    static func makeTwoColumn(at url: URL, index: Int) throws {
        let data = NSMutableData()
        var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)!
        context.beginPDFPage(nil)
        draw("Alex Rivera \\(index)", in: context, x: 48, y: 730, size: 20)
        draw("Staff Platform Engineer", in: context, x: 48, y: 710, size: 13)
        draw("EXPERIENCE", in: context, x: 48, y: 675, size: 11)
        draw("Brightwave Staff Engineer 2021 - Present", in: context, x: 48, y: 655, size: 10.5)
        draw("• Architected multi-region service mesh across 3 cloud clusters.", in: context, x: 48, y: 638)
        draw("• Lowered infrastructure compute spend by 28%.", in: context, x: 48, y: 622)
        draw("SKILLS", in: context, x: 380, y: 675, size: 11)
        draw("• Rust", in: context, x: 380, y: 655)
        draw("• Swift", in: context, x: 380, y: 638)
        draw("• Kubernetes", in: context, x: 380, y: 622)
        draw("• Linux", in: context, x: 380, y: 606)
        draw("EDUCATION", in: context, x: 48, y: 580, size: 11)
        draw("MIT B.S. Computer Science 2018", in: context, x: 48, y: 562, size: 10.5)
        context.endPDFPage()
        context.closePDF()
        try (data as Data).write(to: url)
    }

    static func digitalLinksTruth(index: Int) -> String {
        """
        Jordan Taylor \\(index)
        Principal Systems Engineer
        +1 (555) 010-0199 | GitHub | LinkedIn
        https://github.com/example https://linkedin.com/in/example
        SKILLS
        C++ | Rust | Swift
        Distributed Storage | Consensus
        WORK EXPERIENCE
        Northstar Principal Engineer Feb 2023 - Present
        Built low-latency storage engine reducing tail latency by 40%.
        Automated cluster failover verification across 8 regions.
        Kettle Senior Engineer Nov 2019 - Feb 2023
        Implemented zero-copy replication protocol.
        EDUCATION
        Stanford University M.S. Computer Science 2017 - 2019
        """
    }

    static func makeDigitalLinks(at url: URL, index: Int) throws {
        let data = NSMutableData()
        var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)!
        context.beginPDFPage(nil)
        let lines: [(String, CGFloat, CGFloat)] = [
            ("Jordan Taylor \\(index)", 20, 732),
            ("Principal Systems Engineer", 14, 712),
            ("+1 (555) 010-0199 | GitHub | LinkedIn", 10, 694),
            ("SKILLS", 11, 670),
            ("✔ C++ | Rust | Swift", 10, 654),
            ("✔ Distributed Storage | Consensus", 10, 638),
            ("WORK EXPERIENCE", 11, 612),
            ("Northstar Principal Engineer Feb 2023 - Present", 10.5, 594),
            ("✔ Built low-latency storage engine reducing tail latency by 40%.", 10, 578),
            ("✔ Automated cluster failover verification across 8 regions.", 10, 562),
            ("Kettle Senior Engineer ß Nov 2019 - Feb 2023", 10.5, 540),
            ("✔ Implemented zero-copy replication protocol.", 10, 524),
            ("EDUCATION", 11, 498),
            ("Stanford University M.S. Computer Science 2017 - 2019", 10.5, 480),
        ]
        for (text, size, y) in lines {
            draw(text, in: context, x: 56, y: y, size: size)
        }
        context.setURL(
            URL(string: "https://github.com/example")! as CFURL,
            for: CGRect(x: 150, y: 690, width: 45, height: 14)
        )
        context.setURL(
            URL(string: "https://linkedin.com/in/example")! as CFURL,
            for: CGRect(x: 205, y: 690, width: 55, height: 14)
        )
        context.endPDFPage()
        context.closePDF()
        try (data as Data).write(to: url)
    }

    static func draw(
        _ text: String,
        in context: CGContext,
        x: CGFloat,
        y: CGFloat,
        size: CGFloat = 10
    ) {
        context.textPosition = CGPoint(x: x, y: y)
        let attributes = [
            kCTFontAttributeName: CTFontCreateWithName("Helvetica" as CFString, size, nil),
        ] as CFDictionary
        let attributed = CFAttributedStringCreate(nil, text as CFString, attributes)!
        CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
    }
}
`;
}

function loadExternalManifest() {
  const manifestPath = process.env.PDFVISION_EVAL_CORPUS_MANIFEST;
  if (!manifestPath) return { manifestPath: null, manifest: null };
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`PDFVISION_EVAL_CORPUS_MANIFEST does not exist: ${manifestPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse PDFVISION_EVAL_CORPUS_MANIFEST: ${error.message}`);
  }
  return {
    manifestPath,
    manifest: validateExternalManifest(parsed, { fileExists: fs.existsSync }),
  };
}

function cleanError(error) {
  return String(error?.message ?? error).replaceAll(/\s+/g, ' ').slice(0, 500);
}

function normalizeMarkdown(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  for (const key of ['markdown', 'text', 'content']) {
    if (typeof value?.[key] === 'string') return value[key];
  }
  return '';
}

async function loadAnydoc() {
  let moduleSpecifier = '@firecrawl/anydoc';
  let packagePath = path.join(repoRoot, 'node_modules/@firecrawl/anydoc/package.json');
  if (process.env.ANYDOC_MODULE_DIR) {
    moduleSpecifier = pathToFileURL(path.join(process.env.ANYDOC_MODULE_DIR, 'index.js')).href;
    packagePath = path.join(process.env.ANYDOC_MODULE_DIR, 'package.json');
  }
  if (!fs.existsSync(packagePath)) {
    throw new Error(`anydoc package metadata not found at ${packagePath}`);
  }
  const anydoc = await import(moduleSpecifier);
  if (typeof anydoc.toMarkdownBytes !== 'function') {
    throw new Error('anydoc does not export toMarkdownBytes');
  }
  const packageJSON = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return { toMarkdownBytes: anydoc.toMarkdownBytes, version: packageJSON.version };
}

async function runAnydoc(documents, toMarkdownBytes) {
  const runs = [];
  for (const document of documents) {
    const started = performance.now();
    try {
      const bytes = fs.readFileSync(document.path);
      const markdown = normalizeMarkdown(await toMarkdownBytes(bytes));
      const success = markdown.trim().length > 0;
      runs.push({
        id: document.id,
        category: document.category,
        corpus: document.corpus,
        ms: performance.now() - started,
        success,
        outputNonEmpty: success,
        ...(document.corpus === 'synthetic' ? { markdown, links: [] } : {}),
        ...(!success ? { error: 'empty output' } : {}),
      });
    } catch (error) {
      runs.push({
        id: document.id,
        category: document.category,
        corpus: document.corpus,
        ms: performance.now() - started,
        success: false,
        outputNonEmpty: false,
        error: cleanError(error),
      });
    }
  }
  return runs;
}

function writeMarkitdownRunner(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `import importlib.metadata
import json
import sys
import time

from markitdown import MarkItDown

with open(sys.argv[1], encoding="utf-8") as handle:
    documents = json.load(handle)["documents"]

converter = MarkItDown()
runs = []
for document in documents:
    started = time.perf_counter()
    try:
        markdown = converter.convert(document["path"]).text_content or ""
        success = bool(markdown.strip())
        record = {
            "id": document["id"],
            "category": document["category"],
            "corpus": document["corpus"],
            "ms": (time.perf_counter() - started) * 1000.0,
            "success": success,
            "outputNonEmpty": success,
        }
        if document["corpus"] == "synthetic":
            record["markdown"] = markdown
            record["links"] = []
        if not success:
            record["error"] = "empty output"
        runs.append(record)
    except Exception as error:
        runs.append({
            "id": document["id"],
            "category": document["category"],
            "corpus": document["corpus"],
            "ms": (time.perf_counter() - started) * 1000.0,
            "success": False,
            "outputNonEmpty": False,
            "error": " ".join(str(error).split())[:500],
        })

payload = {
    "version": importlib.metadata.version("markitdown"),
    "runs": runs,
}
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
`
  );
}

function splitRuns(runs) {
  return {
    synthetic: runs.filter(run => run.corpus === 'synthetic'),
    external: runs.filter(run => run.corpus === 'external'),
  };
}

function formatMs(value) {
  return value == null ? '-' : value.toFixed(1);
}

function printTiming(title, timing) {
  console.log(`\n${title}: ${timing.commonSuccessDocuments}/${timing.totalDocuments} common-success documents`);
  console.log('| tool | succeeded | common-success median ms |');
  console.log('| --- | ---: | ---: |');
  for (const [tool, result] of Object.entries(timing.tools)) {
    console.log(`| ${tool} | ${result.succeeded}/${result.attempted} | ${formatMs(result.commonSuccessMedianMs)} |`);
  }
}

function printSyntheticTable(summary) {
  console.log(`\nSynthetic ground-truth quality (${summary.documentCount} digital PDFs)`);
  console.log('| tool | succeeded | failed | score | completeness | structure | formatting | cleanliness |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [tool, result] of Object.entries(summary.tools)) {
    console.log(
      `| ${tool} | ${result.succeeded}/${result.attempted} | ${result.failed} | ${result.score} | ` +
      `${result.completeness} | ${result.structure} | ${result.formatting} | ${result.cleanliness} |`
    );
  }
  printTiming('Synthetic like-for-like timing', summary.timing);
}

function printExternalTable(summary) {
  console.log(`\nExternal completion and timing (${summary.documentCount} digital PDFs)`);
  console.log('| tool | category | attempted | succeeded | failed | median conversion ms |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const [tool, result] of Object.entries(summary.tools)) {
    for (const [category, categoryResult] of Object.entries(result.byCategory)) {
      console.log(
        `| ${tool} | ${category} | ${categoryResult.attempted} | ${categoryResult.succeeded} | ` +
        `${categoryResult.failed} | ${formatMs(categoryResult.medianMs)} |`
      );
    }
  }
  printTiming('External like-for-like timing', summary.timing);
}

export async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('the full evaluation may only run in GitHub Actions');
  }

  const { manifestPath: externalManifestPath, manifest: externalManifest } = loadExternalManifest();
  const buildDirectory = path.join(repoRoot, '.build');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const workDirectory = fs.mkdtempSync(path.join(buildDirectory, 'pdfvision-eval-'));

  try {
    console.log('Building pdfvision and running Swift tests...');
    execFileSync('swift', ['test', '--package-path', repoRoot], { stdio: 'inherit' });
    execFileSync('swift', ['build', '-c', 'release', '--package-path', repoRoot], { stdio: 'inherit' });

    const swiftSourcePath = path.join(workDirectory, 'gen_corpus.swift');
    const pdfMarkdownSource = fs.readFileSync(
      path.join(repoRoot, 'Sources/PDFMarkdown/PDFMarkdown.swift'),
      'utf8'
    );
    fs.writeFileSync(swiftSourcePath, buildSwiftGeneratorSource(pdfMarkdownSource));

    const generatorBinary = path.join(workDirectory, 'gen_corpus_bin');
    execFileSync(
      'swiftc',
      ['-O', '-parse-as-library', swiftSourcePath, '-o', generatorBinary],
      { stdio: 'inherit' }
    );
    const generatorArguments = [workDirectory];
    if (externalManifestPath) generatorArguments.push(externalManifestPath);
    execFileSync(generatorBinary, generatorArguments, { stdio: 'inherit' });

    const swiftPayload = JSON.parse(
      fs.readFileSync(path.join(workDirectory, 'swift_out.json'), 'utf8')
    );
    const documents = swiftPayload.manifest;
    const syntheticDocuments = documents.filter(document => document.corpus === 'synthetic');
    const externalDocuments = documents.filter(document => document.corpus === 'external');

    if (syntheticDocuments.length !== 75) {
      throw new Error(`Swift generator produced ${syntheticDocuments.length} synthetic documents, expected 75`);
    }
    if (externalDocuments.length !== (externalManifest?.documents.length ?? 0)) {
      throw new Error('Swift generator external document count does not match the validated manifest');
    }

    const { toMarkdownBytes, version: anydocVersion } = await loadAnydoc();
    const anydocRuns = await runAnydoc(documents, toMarkdownBytes);

    const toolsManifestPath = path.join(workDirectory, 'tools_manifest.json');
    fs.writeFileSync(toolsManifestPath, JSON.stringify({ documents }));
    const markitdownScriptPath = path.join(workDirectory, 'markitdown_bench.py');
    const markitdownOutputPath = path.join(workDirectory, 'markitdown_out.json');
    writeMarkitdownRunner(markitdownScriptPath);
    execFileSync(
      'python3',
      [markitdownScriptPath, toolsManifestPath, markitdownOutputPath],
      { stdio: 'inherit' }
    );
    if (!fs.existsSync(markitdownOutputPath)) {
      throw new Error('markitdown did not produce its required JSON result file');
    }
    const markitdownPayload = JSON.parse(fs.readFileSync(markitdownOutputPath, 'utf8'));
    if (!Array.isArray(markitdownPayload.runs)) {
      throw new Error('markitdown result file does not contain a runs array');
    }

    const pdfvision = splitRuns(swiftPayload.pdfvision);
    const anydoc = splitRuns(anydocRuns);
    const markitdown = splitRuns(markitdownPayload.runs);
    const syntheticQuality = summarizeSyntheticQuality(syntheticDocuments, {
      pdfvision: pdfvision.synthetic,
      anydoc: anydoc.synthetic,
      markitdown: markitdown.synthetic,
    });
    const externalCompletion = externalDocuments.length === 0
      ? null
      : summarizeExternalCompletion(externalDocuments, {
          pdfvision: pdfvision.external,
          anydoc: anydoc.external,
          markitdown: markitdown.external,
        });

    const sharedMetadata = {
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      runner: os.cpus()[0]?.model || 'unknown',
      mode: 'digital-only',
      sourceCommit: process.env.GITHUB_SHA,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      tools: {
        pdfvision: 'source',
        anydoc: anydocVersion,
        markitdown: markitdownPayload.version,
      },
    };
    const syntheticArtifact = {
      ...sharedMetadata,
      corpus: {
        kind: 'synthetic-ground-truth',
        documentCount: syntheticDocuments.length,
        categories: syntheticQuality.categories,
      },
      syntheticQuality,
      externalCompletion: externalCompletion && {
        documentCount: externalCompletion.documentCount,
        categories: externalCompletion.categories,
        tools: Object.fromEntries(Object.entries(externalCompletion.tools).map(
          ([tool, { byCategory, ...totals }]) => [tool, totals]
        )),
        timing: {
          totalDocuments: externalCompletion.timing.totalDocuments,
          commonSuccessDocuments: externalCompletion.timing.commonSuccessDocuments,
          excludedDocuments: externalCompletion.timing.excludedDocuments,
          tools: externalCompletion.timing.tools,
        },
      },
    };
    const readmePath = path.join(repoRoot, 'README.md');
    const renderedReadme = replaceBenchmarkSection(
      fs.readFileSync(readmePath, 'utf8'),
      renderBenchmarkSection({
        syntheticQuality,
        externalCompletion,
        updatedAt: sharedMetadata.updatedAt,
        runUrl: sharedMetadata.runUrl,
      })
    );

    fs.writeFileSync(
      path.join(repoRoot, 'bench/latest.json'),
      `${JSON.stringify(syntheticArtifact, null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(repoRoot, 'bench/comparison.svg'),
      renderBenchmarkChart({ syntheticQuality, externalCompletion, updatedAt: sharedMetadata.updatedAt })
    );
    if (externalCompletion) {
      const externalArtifact = {
        ...sharedMetadata,
        corpus: {
          kind: 'external-completion',
          schemaVersion: externalManifest.schemaVersion,
          source: externalManifest.source,
          documentCount: externalDocuments.length,
          categories: externalCompletion.categories,
        },
        externalCompletion,
      };
      fs.writeFileSync(
        path.join(repoRoot, 'bench/external-latest.json'),
        `${JSON.stringify(externalArtifact, null, 2)}\n`
      );
    }
    fs.writeFileSync(readmePath, renderedReadme);
    printSyntheticTable(syntheticQuality);
    if (externalCompletion) printExternalTable(externalCompletion);
    else console.log('\nNo external corpus manifest was provided; external evaluation was skipped.');
    console.log(
      externalCompletion
        ? '\nWrote README.md, bench/latest.json, and bench/external-latest.json.'
        : '\nWrote README.md and bench/latest.json.'
    );
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
