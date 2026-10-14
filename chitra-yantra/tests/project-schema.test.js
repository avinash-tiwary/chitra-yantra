'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureStructure, scanProject, iterationTarget } = require('../lib/project-schema');

test('filesystem scan recognizes only standard versioned stage artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-schema-'));
  try {
    ensureStructure(root);
    fs.writeFileSync(path.join(root, '00_project', 'ideas.md'), 'legacy data that must not unlock a gate');
    assert.equal(scanProject(root).valid.idea, false);
    fs.writeFileSync(path.join(root, '00_project', 'idea_v1.md'), '# Idea\n\nA valid and sufficiently detailed concept.');
    fs.writeFileSync(path.join(root, '01_research', 'corpus', 'source_notes.md'), '# Notes\n\nA substantial source note for the corpus.');
    fs.writeFileSync(path.join(root, '01_research', 'corpus', 'synthesis_v1.md'), `# Synthesis\n\n${'evidence '.repeat(30)}`);
    fs.writeFileSync(path.join(root, '02_script', 'script_v2_hindi.md'), `# Script\n\n${'narration '.repeat(40)}`);
    const scan = scanProject(root);
    assert.equal(scan.valid.idea, true);
    assert.equal(scan.valid.research, true);
    assert.equal(scan.valid.script, true);
    assert.equal(scan.versions.script, 2);
    assert.equal(iterationTarget(root, 'script', 'hi', 'outline').target, '02_script/outline_v1_hindi.md');
    assert.equal(iterationTarget(root, 'script', 'hi', 'draft').target, '02_script/draft_v1_hindi.md');
    assert.equal(iterationTarget(root, 'script', 'hi', 'factcheck').target, '02_script/factcheck_v1_hindi.md');
    assert.equal(iterationTarget(root, 'script', 'hi', 'critic').target, '02_script/critique_v1_hindi.json');
    assert.equal(iterationTarget(root, 'script', 'hi', 'final').target, '02_script/final_v1_hindi.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audio iteration paths advance independently for voice and mixes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-schema-'));
  try {
    ensureStructure(root);
    fs.writeFileSync(path.join(root, '03_audio', 'takes', 'voice_v3_take_1.wav'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(root, '03_audio', 'mixes', 'final_mix_v1.wav'), Buffer.alloc(2048));
    assert.equal(iterationTarget(root, 'audio', 'hi', 'voice').target, '03_audio/takes/voice_v4_take_1.wav');
    assert.equal(iterationTarget(root, 'audio', 'hi', 'mix').target, '03_audio/mixes/final_mix_v2.wav');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('research stage recognizes research_corpus_*.md and excludes discarded material', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-research-'));
  try {
    ensureStructure(root);
    // Write only material_discarded.md - should NOT validate research stage
    fs.writeFileSync(path.join(root, '01_research', 'material_discarded.md'), '# Discarded\n\nDubious claim excluded from script.');
    assert.equal(scanProject(root).valid.research, false);

    // Write research_corpus_1.md - should validate research stage and detect version 1
    fs.writeFileSync(path.join(root, '01_research', 'research_corpus_1.md'), `# Research Corpus 1\n\n${'verified historical evidence '.repeat(20)}`);
    const scan = scanProject(root);
    assert.equal(scan.valid.research, true);
    assert.equal(scan.versions.research, 1);

    // Writing research_corpus_2.md advances version to 2
    fs.writeFileSync(path.join(root, '01_research', 'research_corpus_2.md'), `# Research Corpus 2\n\n${'deepened research findings '.repeat(20)}`);
    const scan2 = scanProject(root);
    assert.equal(scan2.versions.research, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('research writer and auditor keep a shared dossier version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-research-v2-'));
  try {
    ensureStructure(root);
    assert.equal(iterationTarget(root, 'research', 'hi', 'prepare').target, '01_research/manifest_v1.json');
    fs.writeFileSync(path.join(root, '01_research', 'manifest_v1.json'), '{}');
    assert.equal(iterationTarget(root, 'research', 'hi', 'write').target, '01_research/dossiers/evidence_v1.md');
    fs.writeFileSync(path.join(root, '01_research', 'dossiers', 'evidence_v1.md'), '# Evidence\n\n' + 'claim '.repeat(50));
    assert.equal(iterationTarget(root, 'research', 'hi', 'audit').target, '01_research/verification/verification_v1.md');
    assert.equal(iterationTarget(root, 'research', 'hi', 'remediate').target, '01_research/remediation/remediation_v1.md');
    assert.equal(iterationTarget(root, 'research', 'hi', 'prepare').target, '01_research/manifest_v2.json');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
