import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  commonSuccessTiming,
  renderBenchmarkSection,
  replaceBenchmarkSection,
  runSucceeded,
  scoreOutput,
  summarizeExternalCompletion,
  summarizeSyntheticQuality,
  validateExternalManifest,
} from './eval-metrics.mjs';
import { buildSwiftGeneratorSource } from './run-eval.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function syntheticDocument(id, category = 'digital-single') {
  return {
    id,
    category,
    corpus: 'synthetic',
    groundTruth: 'alpha beta gamma',
    expectedHeadings: 1,
    expectedBullets: 1,
    expectedLinks: [],
  };
}

function successfulRun(id, overrides = {}) {
  return {
    id,
    success: true,
    outputNonEmpty: true,
    markdown: '# alpha beta gamma\n- item',
    links: [],
    ms: 10,
    ...overrides,
  };
}

test('Swift generator is digital-only and disables OCR for every conversion', () => {
  const source = buildSwiftGeneratorSource('// PDFMarkdown API is appended here');

  assert.doesNotMatch(source, /AppKit|makeScanned|scanned-ocr|ocr:\s*\.(?:automatic|always)/);
  assert.match(source, /for index in 0\.\.<25/);
  assert.equal((source.match(/"corpus": "synthetic"/g) ?? []).length, 3);
  assert.equal((source.match(/PDFMarkdown\.extract/g) ?? []).length, 1);
  assert.match(source, /PDFMarkdown\.extract\(at: url, ocr: \.disabled\)/);
});

test('empty and failed outputs count as failures and zero quality', () => {
  const documents = [
    syntheticDocument('success'),
    syntheticDocument('empty'),
    syntheticDocument('error'),
  ];
  const runs = [
    successfulRun('success'),
    successfulRun('empty', { markdown: '   ' }),
    {
      id: 'error',
      success: false,
      outputNonEmpty: false,
      error: 'conversion failed',
      ms: 5,
    },
  ];

  assert.equal(runSucceeded(runs[1]), false);
  assert.deepEqual(scoreOutput(runs[2], documents[2]), {
    score: 0,
    completeness: 0,
    structure: 0,
    formatting: 0,
    cleanliness: 0,
  });

  const summary = summarizeSyntheticQuality(documents, { tool: runs }).tools.tool;
  assert.equal(summary.attempted, 3);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.errors.length, 2);
  assert.ok(summary.score < scoreOutput(runs[0], documents[0]).score);
});

test('external documents never enter ground-truth quality scoring', () => {
  const documents = [
    { id: 'sinabis-1', category: 'invoice', corpus: 'external' },
  ];
  const completion = summarizeExternalCompletion(documents, {
    tool: [{
      id: 'sinabis-1',
      success: true,
      outputNonEmpty: true,
      ms: 12,
    }],
  });

  assert.equal(completion.tools.tool.succeeded, 1);
  assert.equal('score' in completion.tools.tool, false);
  assert.deepEqual(completion.tools.tool.byCategory.invoice.errors, []);
  assert.throws(
    () => summarizeSyntheticQuality(documents, { tool: [] }),
    /missing groundTruth/
  );
});

test('timing uses only the common-success document intersection', () => {
  const documents = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ];
  const timing = commonSuccessTiming(documents, {
    first: [
      successfulRun('a', { ms: 10 }),
      successfulRun('b', { ms: 20 }),
      successfulRun('c', { ms: 30 }),
    ],
    second: [
      successfulRun('a', { ms: 100 }),
      { id: 'b', success: false, outputNonEmpty: false, error: 'failed', ms: 2 },
      successfulRun('c', { markdown: '', ms: 300 }),
    ],
  });

  assert.deepEqual(timing.commonSuccessDocumentIds, ['a']);
  assert.equal(timing.commonSuccessDocuments, 1);
  assert.equal(timing.tools.first.commonSuccessMedianMs, 10);
  assert.equal(timing.tools.second.commonSuccessMedianMs, 100);
});

test('link formatting requires the exact expected URLs', () => {
  const truth = {
    groundTruth: 'alpha beta gamma',
    expectedHeadings: 1,
    expectedBullets: 1,
    expectedLinks: ['https://example.com/a', 'https://example.com/b'],
    hasTable: false,
  };
  const score = scoreOutput(
    successfulRun('links', {
      links: ['https://example.com/a', 'https://unrelated.example/'],
    }),
    truth
  );

  assert.equal(score.formatting, 85);
});

test('external manifest validation enforces the pinned digital corpus contract', () => {
  const manifest = {
    schemaVersion: 1,
    source: {
      name: 'Sinabis 10k synthetic PDF',
      repository: 'sinabis-group/sinabis-10k-synthetic-pdf',
      revision: '40cc6716836baa5c3629ae9dba11c3319875a34c',
      license: 'CC-BY-4.0',
    },
    documents: [{
      id: 'sinabis-1',
      category: 'invoice',
      path: '/runner/corpus/1.pdf',
      scanned: false,
    }],
  };

  assert.equal(
    validateExternalManifest(manifest, { fileExists: () => true }).documents.length,
    1
  );
  assert.throws(
    () => validateExternalManifest({
      ...manifest,
      documents: [{ ...manifest.documents[0], scanned: true }],
    }),
    /scanned:false/
  );
  assert.throws(
    () => validateExternalManifest({
      ...manifest,
      source: { ...manifest.source, revision: '0'.repeat(40) },
    }),
    /source\.revision/
  );
});

test('benchmark rendering uses dynamic counts and documents scoring semantics', () => {
  const syntheticQuality = {
    documentCount: 7,
    categories: ['layout-a', 'layout-b'],
    tools: {
      pdfvision: {
        attempted: 7,
        succeeded: 6,
        failed: 1,
        score: 88,
        completeness: 90,
        structure: 80,
        formatting: 87,
        cleanliness: 95,
      },
    },
    timing: {
      totalDocuments: 7,
      commonSuccessDocuments: 5,
      tools: {
        pdfvision: {
          attempted: 7,
          succeeded: 6,
          commonSuccessMedianMs: 12.34,
        },
      },
    },
  };
  const externalCompletion = {
    documentCount: 11,
    categories: ['invoice'],
    tools: {
      pdfvision: {
        attempted: 11,
        succeeded: 9,
        failed: 2,
        byCategory: {
          invoice: {
            attempted: 11,
            succeeded: 9,
            failed: 2,
            medianMs: 23.45,
          },
        },
      },
    },
    timing: {
      totalDocuments: 11,
      commonSuccessDocuments: 8,
      tools: {
        pdfvision: {
          attempted: 11,
          succeeded: 9,
          commonSuccessMedianMs: 20.25,
        },
      },
    },
  };

  const rendered = renderBenchmarkSection({
    syntheticQuality,
    externalCompletion,
    updatedAt: '2026-11-11T00:00:00.000Z',
  });

  assert.match(rendered, /Synthetic digital quality \(7 PDFs\)/);
  assert.match(rendered, /2 categories: `layout-a`, `layout-b`/);
  assert.match(rendered, /zero quality points/);
  assert.match(rendered, /5\/7 documents successfully converted by every tool/);
  assert.match(rendered, /External digital completion and timing \(11 PDFs\)/);
  assert.match(rendered, /no matching Markdown ground truth/);
  assert.match(rendered, /8\/11 documents successfully converted by every tool/);
  assert.doesNotMatch(rendered, /100 PDFs|four categories|OCR/i);
});

test('benchmark marker replacement is exact and rejects missing markers', () => {
  const readme = 'before\n<!-- BENCHMARK:START -->\nold\n<!-- BENCHMARK:END -->\nafter\n';
  const section = '<!-- BENCHMARK:START -->\nnew\n<!-- BENCHMARK:END -->';

  assert.equal(
    replaceBenchmarkSection(readme, section),
    `before\n${section}\nafter\n`
  );
  assert.throws(
    () => replaceBenchmarkSection('no benchmark markers', section),
    /exactly one/
  );
});

test('direct runner invocation fails at the CI guard before manifest or dependency work', () => {
  const env = {
    ...process.env,
    PDFVISION_EVAL_CORPUS_MANIFEST: path.join(repoRoot, '.build', 'missing-eval-manifest.json'),
    ANYDOC_MODULE_DIR: path.join(repoRoot, '.build', 'missing-anydoc'),
  };
  delete env.GITHUB_ACTIONS;
  const result = spawnSync(process.execPath, ['scripts/run-eval.mjs'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full evaluation may only run in GitHub Actions/);
  assert.doesNotMatch(result.stderr, /manifest does not exist|anydoc package metadata/);
  assert.equal(fs.existsSync(env.PDFVISION_EVAL_CORPUS_MANIFEST), false);
});
