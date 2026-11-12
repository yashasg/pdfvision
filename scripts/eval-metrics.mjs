import path from 'node:path';

const EXTERNAL_SOURCE = Object.freeze({
  name: 'Sinabis 10k synthetic PDF',
  repository: 'sinabis-group/sinabis-10k-synthetic-pdf',
  revision: '40cc6716836baa5c3629ae9dba11c3319875a34c',
  license: 'CC-BY-4.0',
});

function words(text) {
  return String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function trigrams(text) {
  const tokens = words(text);
  const result = new Set();
  for (let index = 0; index < tokens.length - 2; index++) {
    result.add(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
  }
  return result;
}

function containment(expected, actual) {
  if (expected.size === 0) return 1;
  let matches = 0;
  for (const value of expected) {
    if (actual.has(value)) matches++;
  }
  return matches / expected.size;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function roundedMean(values) {
  return Math.round(mean(values));
}

function markerCount(markdown, marker) {
  return markdown.split(marker).length - 1;
}

export function replaceBenchmarkSection(readme, section) {
  const startMarker = '<!-- BENCHMARK:START -->';
  const endMarker = '<!-- BENCHMARK:END -->';
  if (markerCount(readme, startMarker) !== 1 || markerCount(readme, endMarker) !== 1) {
    throw new Error('README must contain exactly one BENCHMARK:START and BENCHMARK:END marker');
  }
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker, start);
  if (end < start) throw new Error('README benchmark markers are out of order');
  return `${readme.slice(0, start)}${section}${readme.slice(end + endMarker.length)}`;
}

export function renderBenchmarkSection({
  syntheticQuality,
  externalCompletion,
  updatedAt,
  runUrl,
}) {
  const syntheticTiming = syntheticQuality.timing;
  const categories = syntheticQuality.categories.map(category => `\`${category}\``).join(', ');
  const sections = [
    '<!-- BENCHMARK:START -->',
    '![Digital PDF benchmark: synthetic quality, conversion completion, and common-success timing](bench/comparison.svg)',
    '',
    `Synthetic digital quality (${syntheticQuality.documentCount} PDFs): ` +
      `${syntheticQuality.categories.length} categories: ${categories}. ` +
      'Failed or empty conversions receive zero quality points. ' +
      `${syntheticTiming.commonSuccessDocuments}/${syntheticTiming.totalDocuments} documents ` +
      'successfully converted by every tool.',
    '',
  ];

  if (externalCompletion) {
    const externalTiming = externalCompletion.timing;
    sections.push(
      `External digital completion and timing (${externalCompletion.documentCount} PDFs): ` +
        'no matching Markdown ground truth, so no quality score. ' +
        `Speed uses the same ${externalTiming.commonSuccessDocuments}/${externalTiming.totalDocuments} ` +
        'documents successfully converted by every tool; failures remain in the completion counts.',
      '',
    );
  }

  sections.push(
    `[Scores and chart data](bench/latest.json). ` +
      (runUrl ? `[Full reports and per-category results](${runUrl}). ` : '') +
      `Measured ${updatedAt.slice(0, 10)}. Higher quality/completion is better; lower time is better.`,
    '<!-- BENCHMARK:END -->'
  );
  return sections.join('\n');
}

function escapeXML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function renderBenchmarkChart({ syntheticQuality, externalCompletion, updatedAt }) {
  const completion = externalCompletion ?? syntheticQuality;
  const timing = completion.timing;
  const cohort = externalCompletion ? 'external digital PDFs' : 'generated digital PDFs';
  const tools = Object.keys(syntheticQuality.tools);
  const colors = { pdfvision: '#2563eb', anydoc: '#7c3aed', markitdown: '#64748b' };
  const milliseconds = tools.map(tool => timing.tools[tool].commonSuccessMedianMs);
  const panels = [
    {
      title: 'Quality score',
      subtitle: `${syntheticQuality.documentCount} generated digital PDFs - higher is better`,
      maximum: 100,
      values: tools.map(tool => syntheticQuality.tools[tool].score),
      label: value => `${value} / 100`,
    },
    {
      title: 'Conversion completion',
      subtitle: `${completion.documentCount} ${cohort} - nonempty output, not accuracy`,
      maximum: 100,
      values: tools.map(tool => {
        const result = completion.tools[tool];
        return result.attempted === 0 ? null : result.succeeded / result.attempted * 100;
      }),
      label: (value, tool) => {
        const result = completion.tools[tool];
        return `${value.toFixed(1)}% (${result.succeeded}/${result.attempted})`;
      },
    },
    {
      title: 'Median conversion time',
      subtitle: `${timing.commonSuccessDocuments}/${timing.totalDocuments} common-success ${cohort} - lower is better`,
      maximum: Math.max(1, ...milliseconds.filter(value => value !== null)),
      values: milliseconds,
      label: value => `${value.toFixed(2)} ms`,
    },
  ];
  const rowHeight = 42;
  const panelHeight = 100 + tools.length * rowHeight;
  const height = 72 + panels.length * (panelHeight + 16);
  const descriptions = [];
  const rendered = panels.map((panel, index) => {
    if (!Number.isFinite(panel.maximum) || panel.maximum <= 0) {
      throw new Error(`Invalid chart scale: ${panel.title}`);
    }
    const rows = tools.map((tool, row) => {
      const value = panel.values[row];
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > panel.maximum)) {
        throw new Error(`Invalid chart value for ${tool}: ${panel.title}`);
      }
      const label = value === null ? 'not available' : panel.label(value, tool);
      descriptions.push(`${panel.title}, ${tool}: ${label}`);
      const width = value === null ? 0 : value / panel.maximum * 400;
      const y = 88 + row * rowHeight;
      return `<text x="20" y="${y + 17}" class="tool">${escapeXML(tool)}</text>
<rect x="154" y="${y}" width="400" height="24" rx="4" fill="#f1f5f9"/>
<rect x="154" y="${y}" width="${width.toFixed(2)}" height="24" rx="4" fill="${colors[tool] ?? '#475569'}"/>
<text x="764" y="${y + 17}" text-anchor="end" class="value">${escapeXML(label)}</text>`;
    }).join('\n');
    return `<g transform="translate(24 ${24 + index * (panelHeight + 16)})">
<rect width="792" height="${panelHeight}" rx="12" fill="#fff" stroke="#e2e8f0"/>
<text x="20" y="32" class="heading">${escapeXML(panel.title)}</text>
<text x="20" y="57" class="note">${escapeXML(panel.subtitle)}</text>
${rows}
<text x="154" y="${panelHeight - 12}" class="note">0</text>
<text x="554" y="${panelHeight - 12}" text-anchor="end" class="note">${escapeXML(panel.maximum.toFixed(1))}</text>
</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="${height}" viewBox="0 0 840 ${height}" role="img" aria-labelledby="title description">
<title id="title">Digital PDF conversion comparison</title>
<desc id="description">${escapeXML(descriptions.join('. '))}. All bar axes start at zero. Speed uses only documents converted by every tool.</desc>
<style>text{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#0f172a}.heading{font-size:20px;font-weight:650}.tool{font-size:16px;font-weight:600}.value{font-size:14px}.note{font-size:13px;fill:#475569}</style>
<rect width="840" height="${height}" rx="16" fill="#f8fafc"/>
${rendered}
<text x="44" y="${height - 20}" class="note">Digital only - ${escapeXML(updatedAt.slice(0, 10))}. Quality is a synthetic heuristic score, not document accuracy.</text>
</svg>\n`;
}

export function runSucceeded(run) {
  if (!run || run.success !== true) return false;
  if (typeof run.markdown === 'string') return run.markdown.trim().length > 0;
  return run.outputNonEmpty === true;
}

export function scoreOutput(run, truth) {
  if (!runSucceeded(run)) {
    return {
      score: 0,
      completeness: 0,
      structure: 0,
      formatting: 0,
      cleanliness: 0,
    };
  }

  const markdown = run.markdown;
  const extractedLinks = new Set([
    ...(run.links ?? []),
    ...(markdown.match(/https?:\/\/[^\s)>\]]+/g) ?? []),
  ]);
  const expectedLinks = truth.expectedLinks ?? [];
  const fullText = `${markdown} ${[...extractedLinks].join(' ')}`;
  const completeness = Math.round(containment(trigrams(truth.groundTruth), trigrams(fullText)) * 100);

  const lines = markdown.split('\n').map(line => line.trim()).filter(Boolean);
  const headingLines = lines.filter(line => /^#{1,6}\s+/.test(line)).length;
  const headingRatio = Math.min(1, headingLines / Math.max(1, truth.expectedHeadings));
  const mergedHeaderPenalty = /[a-z0-9.,;)] +(?:EDUCATION|WORK EXPERIENCE|EXPERIENCE|SKILLS|SUMMARY|PROJECTS)\b/.test(markdown)
    ? 0.35
    : 0;
  const structure = Math.max(0, Math.round((headingRatio - mergedHeaderPenalty) * 100));

  const bulletLines = lines.filter(line => /^(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  const bulletRatio = Math.min(1, bulletLines / Math.max(1, truth.expectedBullets));
  const exactLinksFound = expectedLinks.filter(link => extractedLinks.has(link)).length;
  const linkRatio = expectedLinks.length === 0 ? 1 : exactLinksFound / expectedLinks.length;
  const formatting = Math.round(((bulletRatio * 0.7) + (linkRatio * 0.3)) * 100);

  let cleanScore = 100;
  if (/^\s*\|.*\|\s*$/m.test(markdown) && !truth.hasTable) cleanScore -= 35;
  if (/<\/?(?:u|span|div|font)\b/i.test(markdown)) cleanScore -= 20;
  if (/(?:✔|•).*?(?:✔|•)/.test(markdown)) cleanScore -= 25;
  if (mergedHeaderPenalty > 0) cleanScore -= 15;
  const cleanliness = Math.max(0, cleanScore);

  return {
    score: Math.round((completeness + structure + formatting + cleanliness) / 4),
    completeness,
    structure,
    formatting,
    cleanliness,
  };
}

function uniqueCategories(documents) {
  return [...new Set(documents.map(document => document.category))].sort();
}

function runsById(runs) {
  return new Map(runs.map(run => [run.id, run]));
}

function failedRun(document, run) {
  return {
    id: document.id,
    category: document.category,
    error: run?.error || (run ? 'empty output' : 'missing result'),
  };
}

export function commonSuccessTiming(documents, toolRuns) {
  const indexes = Object.fromEntries(
    Object.entries(toolRuns).map(([tool, runs]) => [tool, runsById(runs)])
  );
  const commonSuccessDocumentIds = documents
    .map(document => document.id)
    .filter(id => Object.values(indexes).every(index => runSucceeded(index.get(id))));

  const tools = {};
  for (const [tool, index] of Object.entries(indexes)) {
    tools[tool] = {
      attempted: documents.length,
      succeeded: documents.filter(document => runSucceeded(index.get(document.id))).length,
      commonSuccessMedianMs: median(
        commonSuccessDocumentIds.map(id => index.get(id).ms)
      ),
    };
  }

  return {
    totalDocuments: documents.length,
    commonSuccessDocuments: commonSuccessDocumentIds.length,
    excludedDocuments: documents.length - commonSuccessDocumentIds.length,
    commonSuccessDocumentIds,
    tools,
  };
}

export function summarizeSyntheticQuality(documents, toolRuns) {
  for (const document of documents) {
    if (typeof document.groundTruth !== 'string') {
      throw new Error(`synthetic document ${document.id} is missing groundTruth`);
    }
  }

  const categories = uniqueCategories(documents);
  const tools = {};
  for (const [tool, runs] of Object.entries(toolRuns)) {
    const index = runsById(runs);
    const byCategory = {};
    const errors = [];

    for (const category of categories) {
      const categoryDocuments = documents.filter(document => document.category === category);
      const scores = categoryDocuments.map(document => {
        const run = index.get(document.id);
        if (!runSucceeded(run)) errors.push(failedRun(document, run));
        return scoreOutput(run, { ...document, hasTable: false });
      });
      const succeeded = categoryDocuments.filter(document => runSucceeded(index.get(document.id))).length;
      byCategory[category] = {
        attempted: categoryDocuments.length,
        succeeded,
        failed: categoryDocuments.length - succeeded,
        score: roundedMean(scores.map(score => score.score)),
        completeness: roundedMean(scores.map(score => score.completeness)),
        structure: roundedMean(scores.map(score => score.structure)),
        formatting: roundedMean(scores.map(score => score.formatting)),
        cleanliness: roundedMean(scores.map(score => score.cleanliness)),
        medianMs: median(
          categoryDocuments
            .map(document => index.get(document.id))
            .filter(runSucceeded)
            .map(run => run.ms)
        ),
      };
    }

    const succeeded = documents.filter(document => runSucceeded(index.get(document.id))).length;
    tools[tool] = {
      attempted: documents.length,
      succeeded,
      failed: documents.length - succeeded,
      score: roundedMean(categories.map(category => byCategory[category].score)),
      completeness: roundedMean(categories.map(category => byCategory[category].completeness)),
      structure: roundedMean(categories.map(category => byCategory[category].structure)),
      formatting: roundedMean(categories.map(category => byCategory[category].formatting)),
      cleanliness: roundedMean(categories.map(category => byCategory[category].cleanliness)),
      byCategory,
      errors,
    };
  }

  return {
    documentCount: documents.length,
    categories,
    tools,
    timing: commonSuccessTiming(documents, toolRuns),
  };
}

export function summarizeExternalCompletion(documents, toolRuns) {
  const categories = uniqueCategories(documents);
  const tools = {};

  for (const [tool, runs] of Object.entries(toolRuns)) {
    const index = runsById(runs);
    const byCategory = {};

    for (const category of categories) {
      const categoryDocuments = documents.filter(document => document.category === category);
      const successfulRuns = [];
      const errors = [];
      for (const document of categoryDocuments) {
        const run = index.get(document.id);
        if (runSucceeded(run)) successfulRuns.push(run);
        else errors.push(failedRun(document, run));
      }
      byCategory[category] = {
        attempted: categoryDocuments.length,
        succeeded: successfulRuns.length,
        failed: categoryDocuments.length - successfulRuns.length,
        medianMs: median(successfulRuns.map(run => run.ms)),
        errors,
      };
    }

    const successfulRuns = documents
      .map(document => index.get(document.id))
      .filter(runSucceeded);
    tools[tool] = {
      attempted: documents.length,
      succeeded: successfulRuns.length,
      failed: documents.length - successfulRuns.length,
      medianMs: median(successfulRuns.map(run => run.ms)),
      byCategory,
    };
  }

  return {
    documentCount: documents.length,
    categories,
    tools,
    timing: commonSuccessTiming(documents, toolRuns),
  };
}

export function validateExternalManifest(manifest, { fileExists = () => true } = {}) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error('external corpus manifest schemaVersion must be 1');
  }
  for (const [key, expected] of Object.entries(EXTERNAL_SOURCE)) {
    if (manifest.source?.[key] !== expected) {
      throw new Error(`external corpus source.${key} must be ${JSON.stringify(expected)}`);
    }
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error('external corpus manifest documents must be a non-empty array');
  }

  const ids = new Set();
  const documents = manifest.documents.map((document, index) => {
    const prefix = `external corpus document ${index}`;
    if (!/^sinabis-\d+$/.test(document?.id ?? '')) {
      throw new Error(`${prefix} has invalid id`);
    }
    if (ids.has(document.id)) throw new Error(`${prefix} duplicates id ${document.id}`);
    ids.add(document.id);
    if (typeof document.category !== 'string' || document.category.length === 0) {
      throw new Error(`${prefix} has invalid category`);
    }
    if (typeof document.path !== 'string' || !path.isAbsolute(document.path)) {
      throw new Error(`${prefix} path must be absolute`);
    }
    if (!fileExists(document.path)) throw new Error(`${prefix} file does not exist: ${document.path}`);
    if (document.scanned !== false) throw new Error(`${prefix} must declare scanned:false`);
    return {
      id: document.id,
      category: document.category,
      path: document.path,
      scanned: false,
      corpus: 'external',
    };
  });

  return {
    schemaVersion: 1,
    source: { ...manifest.source },
    documents,
  };
}
