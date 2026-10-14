'use strict';

// Release contracts are deliberately plain JSON files.  They are portable with a
// workspace, independently inspectable, and prevent a later "latest file" from
// silently changing what was reviewed or released.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QUALITY_DIMENSIONS = Object.freeze([
  ['factual', 'Factual integrity and source honesty', 20],
  ['narrative', 'Story, hook, pacing, and retention design', 20],
  ['visual', 'Visual specificity and explanatory power', 15],
  ['audio', 'Voice, music, mix, and sound design', 15],
  ['packaging', 'Title, thumbnail, and audience promise', 15],
  ['accessibility', 'Accessibility, trust, and viewer respect', 10],
  ['technical', 'Technical delivery', 5],
]);
const PRIVATE_UPLOAD_THRESHOLD = 85;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileEntry(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Release contract paths must be non-empty workspace-relative paths');
  }
  const file = path.resolve(root, relativePath);
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.statSync(file).isFile()) {
    throw new Error(`Release contract file is unavailable: ${relativePath}`);
  }
  return { path: relativePath.replaceAll('\\', '/'), sha256: sha256(file), bytes: fs.statSync(file).size };
}

function validateQualityReport(report) {
  const problems = [];
  if (!report || Number(report.schemaVersion) !== 1) problems.push('Quality report schemaVersion must be 1');
  const entries = report && typeof report.dimensions === 'object' ? report.dimensions : {};
  let score = 0;
  for (const [id, label, maximum] of QUALITY_DIMENSIONS) {
    const entry = entries[id];
    if (!entry || typeof entry !== 'object') { problems.push(`Missing ${label} review`); continue; }
    const value = Number(entry.score);
    if (!Number.isFinite(value) || value < 0 || value > maximum) problems.push(`${label} must be 0–${maximum}`);
    else score += value;
    if (!String(entry.reviewer || '').trim()) problems.push(`${label} has no independent reviewer`);
    if (!String(entry.evidence || '').trim()) problems.push(`${label} has no review evidence`);
  }
  const blockers = Array.isArray(report?.blockers) ? report.blockers.filter((item) => item && typeof item === 'object') : [];
  const unresolved = blockers.filter((item) => !String(item.overrideRationale || '').trim());
  return { valid: !problems.length, problems, score: Number(score.toFixed(2)), blockers, unresolvedBlockers: unresolved };
}

function buildReleaseManifest({ root, projectKey, selection, qualityReportPath, evidenceIndexPath, owner = null }) {
  if (!selection || typeof selection !== 'object') throw new Error('A deliberate release selection is required');
  const required = ['script', 'blueprint', 'audioMix', 'video', 'qcReport', 'metadata', 'thumbnail', 'subtitles', 'voiceProfile'];
  const missing = required.filter((key) => !selection[key]);
  if (missing.length) throw new Error(`Release selection is incomplete: ${missing.join(', ')}`);
  const artifacts = Object.fromEntries(required.map((key) => [key, fileEntry(root, selection[key])]));
  const qualityReport = fileEntry(root, qualityReportPath);
  const evidenceIndex = fileEntry(root, evidenceIndexPath);
  return {
    schemaVersion: 1,
    projectKey,
    createdAt: new Date().toISOString(),
    owner,
    artifacts,
    qualityReport,
    evidenceIndex,
    selectedPackage: {
      title: String(selection.title || ''),
      thumbnailHypothesis: String(selection.thumbnailHypothesis || ''),
    },
  };
}

function verifyReleaseManifest(root, manifest) {
  const problems = [];
  if (!manifest || Number(manifest.schemaVersion) !== 1) return ['Release manifest schemaVersion must be 1'];
  for (const [name, entry] of Object.entries(manifest.artifacts || {})) {
    try {
      const current = fileEntry(root, entry.path);
      if (current.sha256 !== entry.sha256) problems.push(`${name} changed after release review`);
    } catch (error) { problems.push(error.message); }
  }
  for (const [name, entry] of Object.entries({ qualityReport: manifest.qualityReport, evidenceIndex: manifest.evidenceIndex })) {
    try {
      const current = fileEntry(root, entry?.path);
      if (current.sha256 !== entry.sha256) problems.push(`${name} changed after release review`);
    } catch (error) { problems.push(error.message); }
  }
  return problems;
}

module.exports = { QUALITY_DIMENSIONS, PRIVATE_UPLOAD_THRESHOLD, sha256, fileEntry, validateQualityReport, buildReleaseManifest, verifyReleaseManifest };
