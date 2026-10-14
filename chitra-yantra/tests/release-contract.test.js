'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateQualityReport, buildReleaseManifest, verifyReleaseManifest, PRIVATE_UPLOAD_THRESHOLD } = require('../lib/release-contract');

function report(score = 85) {
  const values = { factual: 20, narrative: 20, visual: 15, audio: 15, packaging: 15, accessibility: 10, technical: 5 };
  let remaining = score;
  return { schemaVersion: 1, dimensions: Object.fromEntries(Object.entries(values).map(([id, maximum]) => {
    const value = Math.max(0, Math.min(maximum, remaining)); remaining -= value;
    return [id, { score: value, reviewer: 'independent-reviewer', evidence: 'Inspected immutable artifact.' }];
  })), blockers: [] };
}

test('quality report enforces all independent dimensions and the private threshold', () => {
  const eligible = validateQualityReport(report(PRIVATE_UPLOAD_THRESHOLD));
  assert.equal(eligible.valid, true);
  assert.equal(eligible.score, PRIVATE_UPLOAD_THRESHOLD);
  const incomplete = report(90); delete incomplete.dimensions.visual;
  assert.equal(validateQualityReport(incomplete).valid, false);
});

test('release manifests bind exact selected artifacts and detect drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-release-'));
  try {
    const selection = {};
    for (const key of ['script', 'blueprint', 'audioMix', 'video', 'qcReport', 'metadata', 'thumbnail', 'subtitles', 'voiceProfile']) {
      const relative = `files/${key}.txt`; const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, key); selection[key] = relative;
    }
    fs.mkdirSync(path.join(root, 'quality'), { recursive: true });
    fs.writeFileSync(path.join(root, 'quality/report.json'), JSON.stringify(report()));
    fs.writeFileSync(path.join(root, 'evidence.json'), '{}');
    const manifest = buildReleaseManifest({ root, projectKey: 'example-channel__fixture', selection, qualityReportPath: 'quality/report.json', evidenceIndexPath: 'evidence.json' });
    assert.deepEqual(verifyReleaseManifest(root, manifest), []);
    fs.appendFileSync(path.join(root, selection.video), 'changed');
    assert.match(verifyReleaseManifest(root, manifest).join(' '), /video changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
