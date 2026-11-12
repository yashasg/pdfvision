#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const corpusDir = path.join(root, 'bench/corpus');
const errorMessages = {
  encrypted: ['PDF is encrypted or password-protected'],
  empty: ['PDF has 0 pages', 'invalid or corrupted PDF document'],
  malformed: ['invalid or corrupted PDF document'],
  'no-text': ['PDF has no extractable text ('],
};

export function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported corpus schema');
  assert(manifest.documents.length > 0, 'Corpus must contain PDFs');
  for (const source of Object.values(manifest.sources)) {
    assert.match(source.repository, /^[\w.-]+\/[\w.-]+$/);
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert(source.attribution && source.licenseEvidence, 'Missing attribution');
  }
  const ids = new Set();
  for (const asset of [...manifest.documents, ...manifest.notices]) {
    assert.match(asset.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert(!ids.has(asset.id), `Duplicate asset: ${asset.id}`);
    ids.add(asset.id);
    assert(manifest.sources[asset.source], `Unknown source: ${asset.source}`);
    assert(asset.path && !asset.path.split('/').some(part => part === '..' || part === ''), 'Invalid source path');
    assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, `Invalid size: ${asset.id}`);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
  for (const document of manifest.documents) {
    assert(document.license || manifest.sources[document.source].license, `Missing license: ${document.id}`);
    assert(document.expect === 'text' || Object.hasOwn(errorMessages, document.expect), `Unknown expectation: ${document.id}`);
    assert(document.tags.length > 0 && document.tags.every(tag => typeof tag === 'string'), 'Missing coverage tags');
    assert(document.path.endsWith('.pdf'), 'Expected PDF source path');
  }
  return manifest;
}

export function verifyAsset(data, asset) {
  assert.equal(data.length, asset.bytes, `${asset.id}: byte count mismatch`);
  assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256, `${asset.id}: SHA-256 mismatch`);
}

export async function fetchAsset(asset, url, destination) {
  if (fs.existsSync(destination)) {
    verifyAsset(fs.readFileSync(destination), asset);
    return;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${asset.id}: HTTP ${response.status} (${url})`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > asset.bytes) throw new Error(`${asset.id}: download exceeds expected size`);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  verifyAsset(data, asset);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.download`;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function checkConversion(result, entry) {
  if (result.error || result.signal) return { passed: false, error: result.error?.message || `Signal: ${result.signal}` };
  if (entry.expect !== 'text') {
    const passed = result.status === 1 && errorMessages[entry.expect].some(message => result.stderr.includes(`pdfvision: ${message}`));
    return { passed, error: passed ? null : `Expected ${entry.expect}, got exit ${result.status}: ${result.stderr}` };
  }
  if (result.status !== 0) return { passed: false, error: `Exit ${result.status}: ${result.stderr}` };
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch (error) {
    return { passed: false, error: `Invalid JSON output: ${error.message}` };
  }
  if (!document || typeof document.markdown !== 'string' || !document.markdown.trim()
      || !Number.isInteger(document.pageCount) || document.pageCount < 1
      || !Array.isArray(document.ocrPages)
      || !document.ocrPages.every(page => Number.isInteger(page) && page >= 1 && page <= document.pageCount)) {
    return { passed: false, error: 'Expected nonempty Markdown and page metadata' };
  }
  if (entry.tags.includes('scanned') && document.ocrPages.length === 0) {
    return { passed: false, error: 'Scanned fixture did not exercise OCR' };
  }
  return {
    passed: true,
    pageCount: document.pageCount,
    ocrPages: document.ocrPages,
    characters: document.markdown.length,
  };
}

async function main(command) {
  if (!['fetch', 'check', 'run'].includes(command)) {
    throw new Error('Usage: node scripts/pdf-corpus.mjs <fetch|check|run>');
  }
  if (command === 'fetch' && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Corpus downloads run only in GitHub Actions, not on this device');
  }
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'bench/corpus.json'), 'utf8')));
  const groups = [
    [manifest.documents, 'files', '.pdf'],
    [manifest.notices, 'notices', '.txt'],
  ];
  for (const [assets, directory, extension] of groups) {
    for (const asset of assets) {
      const destination = path.join(corpusDir, directory, asset.id + extension);
      if (command === 'fetch') {
        const source = manifest.sources[asset.source];
        const url = `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${asset.path.split('/').map(encodeURIComponent).join('/')}`;
        await fetchAsset(asset, url, destination);
      } else {
        verifyAsset(fs.readFileSync(destination), asset);
      }
    }
  }
  console.log(`Verified ${manifest.documents.length} PDFs and ${manifest.notices.length} attribution/license files.`);
  if (command !== 'run') return;

  const build = spawnSync('swift', ['build', '-c', 'release', '--package-path', root], { stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Swift build failed: ${build.signal || build.status}`);
  const binPath = spawnSync('swift', ['build', '-c', 'release', '--package-path', root, '--show-bin-path'], { encoding: 'utf8' });
  if (binPath.error) throw binPath.error;
  if (binPath.status !== 0) throw new Error(`Could not locate Swift executable: ${binPath.stderr}`);
  const binary = path.join(binPath.stdout.trim(), 'pdfvision');
  const results = [];
  for (const entry of manifest.documents) {
    const started = performance.now();
    const result = spawnSync(binary, [path.join(corpusDir, 'files', `${entry.id}.pdf`), '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const outcome = checkConversion(result, entry);
    results.push({
      id: entry.id, tags: entry.tags, expected: entry.expect,
      ...outcome, exitCode: result.status, ms: performance.now() - started, stderr: result.stderr,
    });
    console.log(`${outcome.passed ? 'PASS' : 'FAIL'} ${entry.id}${outcome.error ? `: ${outcome.error}` : ''}`);
  }
  const failed = results.filter(result => !result.passed).length;
  fs.writeFileSync(path.join(corpusDir, 'run.json'), JSON.stringify({
    updatedAt: new Date().toISOString(), platform: process.platform,
    passed: results.length - failed, failed, results,
  }, null, 2) + '\n');
  console.log(`${results.length - failed}/${results.length} smoke cases passed; report: bench/corpus/run.json (not quality scores).`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.length === 3 ? process.argv[2] : undefined).catch(error => {
    console.error(`pdf-corpus: ${error.message}`);
    process.exitCode = 1;
  });
}
