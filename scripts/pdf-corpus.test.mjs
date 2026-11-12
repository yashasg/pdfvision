import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkConversion, fetchAsset, validateManifest } from './pdf-corpus.mjs';

test('corpus fetch refuses local execution before downloading anything', () => {
  const environment = { ...process.env };
  delete environment.GITHUB_ACTIONS;
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./pdf-corpus.mjs', import.meta.url)), 'fetch',
  ], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only in GitHub Actions/);
});

test('downloads are verified, cached, and never written on corrupt or failed responses', async t => {
  const data = Buffer.from('%PDF-1.3\nfixture\n%%EOF\n');
  const asset = { id: 'fixture', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-corpus-test-'));
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    response.statusCode = request.url === '/missing' ? 404 : 200;
    response.end(request.url === '/corrupt' ? Buffer.alloc(data.length) : data);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(directory, 'fixture.pdf');
  await fetchAsset(asset, base, file);
  assert.deepEqual(fs.readFileSync(file), data);
  await fetchAsset(asset, base, file);
  assert.equal(requests, 1, 'valid cache should not use the network');
  fs.writeFileSync(file, Buffer.alloc(data.length));
  await assert.rejects(fetchAsset(asset, base, file), /SHA-256 mismatch/);
  fs.unlinkSync(file);
  await assert.rejects(fetchAsset(asset, base + '/corrupt', file), /SHA-256 mismatch/);
  await assert.rejects(fetchAsset(asset, base + '/missing', file), /HTTP 404/);
  await assert.rejects(fetchAsset({ ...asset, bytes: 1 }, base, file), /exceeds expected size/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('manifest rejects unsafe paths, unpinned sources, duplicate IDs and missing licenses', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../bench/corpus.json', import.meta.url), 'utf8'));
  validateManifest(manifest);
  const change = mutate => {
    const copy = structuredClone(manifest);
    mutate(copy);
    return () => validateManifest(copy);
  };
  assert.throws(change(copy => { copy.documents[0].id = '../escape'; }));
  assert.throws(change(copy => { copy.documents[0].path = '../escape.pdf'; }));
  assert.throws(change(copy => { copy.sources.samples.revision = 'main'; }));
  assert.throws(change(copy => { copy.documents[1].id = copy.documents[0].id; }), /Duplicate asset/);
  assert.throws(change(copy => { delete copy.sources.samples.license; }), /Missing license/);
});

test('smoke checks distinguish successful extraction, intended errors, OCR, and crashes', () => {
  const entry = { expect: 'text', tags: ['scanned'] };
  const result = {
    status: 0, signal: null, stderr: '',
    stdout: JSON.stringify({ markdown: 'Readable text', pageCount: 1, ocrPages: [1] }),
  };
  assert.equal(checkConversion(result, entry).passed, true);
  assert.equal(checkConversion({ ...result, stdout: '{}' }, entry).passed, false);
  assert.equal(checkConversion({ ...result, stdout: 'null' }, entry).passed, false);
  assert.equal(checkConversion({ ...result, stdout: 'not JSON' }, entry).passed, false);
  assert.equal(checkConversion({
    ...result, stdout: JSON.stringify({ markdown: 'Text', pageCount: 1, ocrPages: [] }),
  }, entry).passed, false);
  assert.equal(checkConversion({
    ...result, stdout: JSON.stringify({ markdown: 'Text', pageCount: 1, ocrPages: [2] }),
  }, entry).passed, false);
  assert.equal(checkConversion({ ...result, signal: 'SIGSEGV' }, entry).passed, false);
  const rejected = { ...result, status: 1, stderr: 'pdfvision: PDF is encrypted or password-protected\n' };
  assert.equal(checkConversion(rejected, { expect: 'encrypted' }).passed, true);
  assert.equal(checkConversion(rejected, { expect: 'malformed' }).passed, false);
  assert.equal(checkConversion(rejected, entry).passed, false);
  assert.equal(checkConversion(result, { expect: 'encrypted' }).passed, false);
  const empty = { ...rejected, stderr: 'pdfvision: PDF has 0 pages\n' };
  const malformed = { ...rejected, stderr: 'pdfvision: invalid or corrupted PDF document\n' };
  assert.equal(checkConversion(empty, { expect: 'empty' }).passed, true);
  assert.equal(checkConversion(malformed, { expect: 'empty' }).passed, true);
  assert.equal(checkConversion(empty, { expect: 'malformed' }).passed, false);
});
