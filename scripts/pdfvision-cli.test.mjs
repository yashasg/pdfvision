import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.build', `pdfvision-cli-test-${process.pid}`);

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    input: options.input,
  });
}

function requireSuccess(result, description) {
  assert.equal(
    result.status,
    0,
    `${description} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function findBinary() {
  if (process.env.PDFVISION_BIN) {
    return path.resolve(process.env.PDFVISION_BIN);
  }

  const build = command('swift', ['build', '--product', 'pdfvision']);
  requireSuccess(build, 'swift build --product pdfvision');
  const binPath = command('swift', ['build', '--show-bin-path']);
  requireSuccess(binPath, 'swift build --show-bin-path');
  return path.join(binPath.stdout.trim(), 'pdfvision');
}

const binary = findBinary();
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fixtureDirectory(name) {
  const directory = path.join(scratch, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function pdfFixture(text) {
  const escapedText = text?.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = escapedText
    ? `BT /F1 18 Tf 72 720 Td (${escapedText}) Tj ET`
    : '0 0 0 rg 72 72 200 200 re f';
  const resources = escapedText ? '/Resources << /Font << /F1 5 0 R >> >> ' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources}/Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let contents = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents));
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(contents);
  contents += `xref\n0 ${objects.length + 1}\n`;
  contents += '0000000000 65535 f \n';
  contents += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  contents += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  contents += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(contents);
}

function run(args, options = {}) {
  return command(binary, args, options);
}

test('uses the pdfvision name in help and errors', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^pdfvision 0\.1\.0/m);
  assert.doesNotMatch(help.stdout, /pdf2markit/);

  const error = run(['--unknown']);
  assert.equal(error.status, 2);
  assert.match(error.stderr, /^pdfvision: unknown option: --unknown/m);
});

test('preserves single-file, output-file, stdin, JSON, and -- behavior', () => {
  const directory = fixtureDirectory('single');
  const input = path.join(directory, 'single.pdf');
  const output = path.join(directory, 'single.md');
  const bytes = pdfFixture('Single compatibility text');
  fs.writeFileSync(input, bytes);

  const single = run([input, '--ocr', 'disabled']);
  assert.equal(single.status, 0);
  assert.match(single.stdout, /Single compatibility text/);

  const written = run([input, '--ocr', 'disabled', '-o', output]);
  assert.equal(written.status, 0);
  assert.match(fs.readFileSync(output, 'utf8'), /Single compatibility text/);

  const stdin = run(['-', '--json', '--ocr', 'disabled'], { input: bytes });
  assert.equal(stdin.status, 0);
  assert.match(JSON.parse(stdin.stdout).markdown, /Single compatibility text/);

  const dashInput = path.join(directory, '-dash.pdf');
  fs.writeFileSync(dashInput, pdfFixture('Dash filename text'));
  const dash = run(['--ocr', 'disabled', '--', '-dash.pdf'], { cwd: directory });
  assert.equal(dash.status, 0);
  assert.match(dash.stdout, /Dash filename text/);
});

test('retrieves compact outlines and nested sections from saved Markdown', () => {
  const directory = fixtureDirectory('markdown-context');
  const input = path.join(directory, 'query.md');
  const output = path.join(directory, 'selected.md');
  const markdown = [
    '# Repeated',
    'First section body. '.repeat(12),
    '## Child',
    'Child body. '.repeat(8),
    '```md',
    '# Fake heading',
    '```',
    '# Repeated',
    'Second section body. '.repeat(12),
    '',
  ].join('\n');
  fs.writeFileSync(input, markdown);

  const outline = run([input, '--from-markdown', '--outline']);
  assert.equal(outline.status, 0);
  const entries = JSON.parse(outline.stdout);
  assert.deepEqual(entries, [
    { id: 's1', level: 1, title: 'Repeated' },
    { id: 's2', level: 2, title: 'Child' },
    { id: 's3', level: 1, title: 'Repeated' },
  ]);
  assert.equal(outline.stdout.trim(), JSON.stringify(entries));
  assert.ok(Buffer.byteLength(outline.stdout) < Buffer.byteLength(markdown));
  assert.doesNotMatch(outline.stdout, /section body|Fake heading/);

  const selected = run([input, '--from-markdown', '--section', 's1', '-o', output]);
  assert.equal(selected.status, 0);
  const selectedMarkdown = fs.readFileSync(output, 'utf8');
  assert.match(selectedMarkdown, /# Repeated/);
  assert.match(selectedMarkdown, /First section body/);
  assert.match(selectedMarkdown, /## Child/);
  assert.match(selectedMarkdown, /Child body/);
  assert.match(selectedMarkdown, /# Fake heading/);
  assert.doesNotMatch(selectedMarkdown, /Second section body/);
});

test('retrieves a selected Markdown section from stdin as compact JSON', () => {
  const markdown = '# First\nFirst body.\n\n# Second\nSecond body.\n';
  const result = run(['-', '--from-markdown', '--section', 's2', '--json'], {
    input: markdown,
  });

  assert.equal(result.status, 0);
  const selected = JSON.parse(result.stdout);
  assert.deepEqual(
    { id: selected.id, level: selected.level, title: selected.title },
    { id: 's2', level: 1, title: 'Second' },
  );
  assert.match(selected.markdown, /Second body/);
  assert.doesNotMatch(selected.markdown, /First body/);
  assert.equal(result.stdout.trim(), JSON.stringify(selected));
});

test('rejects invalid context options and unknown sections without side effects', () => {
  const directory = fixtureDirectory('context-errors');
  const input = path.join(directory, 'query.md');
  fs.writeFileSync(input, '# Present\nBody.\n');

  const cases = [
    [input, '--from-markdown', '--outline', '--section', 's1'],
    ['--batch', input, '--outline'],
    [input, '--from-markdown'],
    [input, '--from-markdown', '--section', 's1', '--section', 's2'],
    [input, '--from-markdown', '--section', ''],
    [input, '--from-markdown', '--section', '--json'],
  ];

  for (const [index, args] of cases.entries()) {
    const output = path.join(directory, `unused-${index}`);
    const result = run([...args, '-o', output]);
    assert.equal(result.status, 2, `${args.join(' ')}\nstderr:\n${result.stderr}`);
    assert.equal(fs.existsSync(output), false);
  }

  const unknownOutput = path.join(directory, 'unknown.md');
  const unknown = run([
    input,
    '--from-markdown',
    '--section',
    's99',
    '-o',
    unknownOutput,
  ]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /s99/);
  assert.equal(fs.existsSync(unknownOutput), false);

  const overwrite = run([input, '--from-markdown', '--outline', '-o', input]);
  assert.equal(overwrite.status, 2);
  assert.equal(fs.readFileSync(input, 'utf8'), '# Present\nBody.\n');

  const invalid = path.join(directory, 'invalid.md');
  fs.writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
  const invalidResult = run([invalid, '--from-markdown', '--outline', '-o', unknownOutput]);
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /not valid UTF-8/);
  assert.equal(fs.existsSync(unknownOutput), false);
});

test('retrieves an outline and section after converting a PDF', () => {
  const directory = fixtureDirectory('pdf-context');
  const input = path.join(directory, 'heading.pdf');
  fs.writeFileSync(input, pdfFixture('PDF Outline Heading'));

  const outline = run([input, '--outline', '--ocr', 'disabled']);
  assert.equal(outline.status, 0);
  assert.deepEqual(JSON.parse(outline.stdout), [
    { id: 's1', level: 1, title: 'PDF Outline Heading' },
  ]);

  const section = run([input, '--section', 's1', '--ocr', 'disabled']);
  assert.equal(section.status, 0);
  assert.match(section.stdout, /^# PDF Outline Heading/m);
});

test('batch mode writes one Markdown or JSON file per input', () => {
  const directory = fixtureDirectory('batch-formats');
  const markdownOutput = path.join(directory, 'markdown');
  const jsonOutput = path.join(directory, 'json');
  fs.mkdirSync(jsonOutput);
  const first = path.join(directory, 'first.pdf');
  const second = path.join(directory, 'second.pdf');
  fs.writeFileSync(first, pdfFixture('First batch text'));
  fs.writeFileSync(second, pdfFixture('Second batch text'));

  const markdown = run(['--batch', first, second, '--ocr', 'disabled', '-o', markdownOutput]);
  assert.equal(markdown.status, 0);
  assert.equal(fs.statSync(markdownOutput).isDirectory(), true);
  assert.match(fs.readFileSync(path.join(markdownOutput, 'first.md'), 'utf8'), /First batch text/);
  assert.match(fs.readFileSync(path.join(markdownOutput, 'second.md'), 'utf8'), /Second batch text/);
  assert.deepEqual(fs.readdirSync(markdownOutput).sort(), ['first.md', 'second.md']);

  const json = run(['--batch', '--json', first, second, '-o', jsonOutput, '--ocr', 'disabled']);
  assert.equal(json.status, 0);
  assert.match(JSON.parse(fs.readFileSync(path.join(jsonOutput, 'first.json'))).markdown, /First batch text/);
  assert.match(JSON.parse(fs.readFileSync(path.join(jsonOutput, 'second.json'))).markdown, /Second batch text/);
  assert.deepEqual(fs.readdirSync(jsonOutput).sort(), ['first.json', 'second.json']);
});

test('batch preflight rejects missing inputs, stdin, duplicate outputs, and overwrites', () => {
  const directory = fixtureDirectory('preflight');
  const output = path.join(directory, 'output');
  fs.mkdirSync(output);

  const unusedOutput = path.join(directory, 'unused-output');
  assert.equal(run(['--batch', '-o', unusedOutput]).status, 2);
  assert.equal(fs.existsSync(unusedOutput), false);
  assert.equal(run(['--batch', '-', '-o', unusedOutput]).status, 2);
  assert.equal(fs.existsSync(unusedOutput), false);

  const left = path.join(directory, 'left');
  const right = path.join(directory, 'right');
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  const leftInput = path.join(left, 'same.pdf');
  const rightInput = path.join(right, 'same.pdf');
  fs.writeFileSync(leftInput, pdfFixture('Left'));
  fs.writeFileSync(rightInput, pdfFixture('Right'));
  const duplicate = run(['--batch', leftInput, rightInput, '-o', unusedOutput, '--ocr', 'disabled']);
  assert.equal(duplicate.status, 2);
  assert.equal(fs.existsSync(unusedOutput), false);

  const outputFile = path.join(directory, 'not-a-directory');
  fs.writeFileSync(outputFile, 'keep me');
  assert.equal(run(['--batch', leftInput, '-o', outputFile, '--ocr', 'disabled']).status, 2);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'keep me');

  const first = path.join(directory, 'first.pdf');
  const second = path.join(directory, 'second.pdf');
  fs.writeFileSync(first, pdfFixture('First'));
  fs.writeFileSync(second, pdfFixture('Second'));
  fs.writeFileSync(path.join(output, 'second.md'), 'keep me');
  const existing = run(['--batch', first, second, '-o', output, '--ocr', 'disabled']);
  assert.equal(existing.status, 2);
  assert.equal(fs.existsSync(path.join(output, 'first.md')), false);
  assert.equal(fs.readFileSync(path.join(output, 'second.md'), 'utf8'), 'keep me');

  const inputOutput = path.join(directory, 'protected.md');
  const original = pdfFixture('Protected input');
  fs.writeFileSync(inputOutput, original);
  const overwriteInput = run(['--batch', inputOutput, '-o', directory, '--ocr', 'disabled']);
  assert.equal(overwriteInput.status, 2);
  assert.deepEqual(fs.readFileSync(inputOutput), original);
});

test('batch continues after conversion failures and returns exit 1', () => {
  const directory = fixtureDirectory('mixed-failure');
  const output = path.join(directory, 'output');
  fs.mkdirSync(output);
  const malformed = path.join(directory, 'malformed.pdf');
  const valid = path.join(directory, 'valid.pdf');
  fs.writeFileSync(malformed, 'not a PDF');
  fs.writeFileSync(valid, pdfFixture('Converted after failure'));

  const result = run(['--batch', malformed, valid, '-o', output, '--ocr', 'disabled']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`pdfvision: ${malformed.replaceAll('\\', '\\\\')}:`));
  assert.equal(fs.existsSync(path.join(output, 'malformed.md')), false);
  assert.match(fs.readFileSync(path.join(output, 'valid.md'), 'utf8'), /Converted after failure/);
});

test('batch returns exit 3 when every failure only needs disabled OCR', () => {
  const directory = fixtureDirectory('ocr-disabled');
  const output = path.join(directory, 'output');
  fs.mkdirSync(output);
  const valid = path.join(directory, 'valid.pdf');
  const raster = path.join(directory, 'raster.pdf');
  fs.writeFileSync(valid, pdfFixture('Selectable text'));
  fs.writeFileSync(raster, pdfFixture());

  const result = run(['--batch', valid, raster, '-o', output, '--ocr', 'disabled']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, new RegExp(`pdfvision: ${raster.replaceAll('\\', '\\\\')}:`));
  assert.match(fs.readFileSync(path.join(output, 'valid.md'), 'utf8'), /Selectable text/);
  assert.equal(fs.existsSync(path.join(output, 'raster.md')), false);
});
