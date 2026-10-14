'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 5;
const DIRECTORIES = Object.freeze([
  '00_project', '01_research/corpus', '01_research/evidence_cache', '01_research/contracts', '01_research/plans',
  '01_research/passes', '01_research/synthesis', '01_research/dossiers',
  '01_research/claims', '01_research/verification', '01_research/remediation', '02_script',
  '03_audio/takes', '03_audio/music', '03_audio/sfx', '03_audio/processed', '03_audio/mixes', '03_audio/plans',
  '04_visuals/plans', '04_visuals/renders', '04_visuals/thumbnails',
  '05_edit/review_exports', '05_edit/final_exports', '05_edit/timelines',
  '06_publish/subtitles', '06_publish/analytics', '99_archive',
]);

const PATTERNS = Object.freeze({
  idea: /^00_project\/idea_v(\d+)\.md$/i,
  research: /^01_research\/(?:corpus\/)?(?!index\.json$)(?!material_discarded\.md$)(?!discarded\/).+\.(?:md|txt|pdf|html?|csv|json|ya?ml)$/i,
  synthesis: /^01_research\/(?:corpus\/)?(?:synthesis_v(\d+)|research_corpus(?:_v?(\d+))?)\.md$|^01_research\/dossiers\/evidence_v(\d+)\.md$/i,
  script: /^02_script\/(?:script|outline|draft|final)_v(\d+)_([a-z][a-z0-9-]*)\.md$/i,
  finalScript: /^02_script\/final_v(\d+)_([a-z][a-z0-9-]*)\.md$/i,
  scriptFactcheck: /^02_script\/factcheck_v(\d+)_([a-z][a-z0-9-]*)\.md$/i,
  assetPlan: /^04_visuals\/plans\/asset_plan_v(\d+)\.(?:json|md)$/i,
  editorialBlueprint: /^04_visuals\/plans\/editorial_blueprint_v(\d+)\.json$/i,
  voiceTake: /^03_audio\/takes\/.+\.(?:wav|mp3|m4a|flac)$/i,
  musicTake: /^03_audio\/music\/.+\.(?:wav|mp3|m4a|flac)$/i,
  audioMix: /^03_audio\/mixes\/(?:review_mix|final_mix)_v(\d+)\.(?:wav|mp3|m4a|flac)$/i,
  render: /^04_visuals\/renders\/.+\.(?:png|jpe?g|webp)$/i,
  assembly: /^05_edit\/(?:review|final)_exports\/.+\.mp4$/i,
  qc: /^05_edit\/qc_report_v(\d+)\.json$/i,
  metadata: /^06_publish\/metadata_v(\d+)\.json$/i,
});

const STAGE_DIRECTORIES = Object.freeze({
  idea: ['00_project'], research: ['01_research'], script: ['02_script'], audio: ['03_audio'],
  assets: ['04_visuals'], visuals: ['04_visuals'], assembly: ['05_edit'], qc: ['05_edit'],
  package: ['06_publish'], publish: ['06_publish'],
});

function walk(root, relative = '') {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) files.push(...walk(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function validFile(projectPath, relativePath, minimumSize = 20) {
  try { return fs.statSync(path.join(projectPath, relativePath)).isFile() && fs.statSync(path.join(projectPath, relativePath)).size >= minimumSize; }
  catch { return false; }
}

function versionOf(file, pattern) {
  const m = file.match(pattern);
  return Number(m?.[1] || m?.[2] || m?.[3] || 0);
}

function matching(files, pattern, projectPath, minimumSize = 20) {
  return files.filter((file) => pattern.test(file) && validFile(projectPath, file, minimumSize)).sort((left, right) => {
    const versionDelta = versionOf(left, pattern) - versionOf(right, pattern);
    return versionDelta || left.localeCompare(right);
  });
}

function latestVersion(files, pattern) {
  return files.reduce((highest, file) => Math.max(highest, versionOf(file, pattern)), 0);
}

function scanProject(projectPath) {
  const files = walk(projectPath).filter((file) => !file.startsWith('99_archive/'));
  const ideas = matching(files, PATTERNS.idea, projectPath);
  const corpus = matching(files, PATTERNS.research, projectPath);
  const syntheses = matching(files, PATTERNS.synthesis, projectPath, 200);
  const scripts = matching(files, PATTERNS.script, projectPath, 300);
  const scriptFactchecks = matching(files, PATTERNS.scriptFactcheck, projectPath, 20);
  const plans = matching(files, PATTERNS.assetPlan, projectPath, 2);
  const blueprints = matching(files, PATTERNS.editorialBlueprint, projectPath, 2);
  const voiceTakes = matching(files, PATTERNS.voiceTake, projectPath, 1024);
  const musicTakes = matching(files, PATTERNS.musicTake, projectPath, 1024);
  const mixes = matching(files, PATTERNS.audioMix, projectPath, 1024);
  const renders = matching(files, PATTERNS.render, projectPath, 1024);
  const assemblies = matching(files, PATTERNS.assembly, projectPath, 1024);
  const qc = matching(files, PATTERNS.qc, projectPath);
  const metadata = matching(files, PATTERNS.metadata, projectPath);
  const stageFiles = { idea: ideas, research: corpus, script: [...scripts, ...scriptFactchecks], assets: [...plans, ...blueprints], audio: [...voiceTakes, ...musicTakes, ...mixes], visuals: renders, assembly: assemblies, qc, package: metadata };
  const valid = {
    idea: ideas.length > 0,
    research: corpus.length > 0 && syntheses.length > 0,
    script: scripts.length > 0,
    assets: plans.length > 0,
    audio: voiceTakes.length > 0 && musicTakes.length > 0 && mixes.length > 0,
    visuals: renders.length > 0,
    assembly: assemblies.length > 0,
    qc: qc.length > 0,
    package: metadata.length > 0,
    publish: false,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    valid,
    stages: Object.fromEntries(Object.keys(valid).map((stageId) => [stageId, {
      valid: valid[stageId], files: stageFiles[stageId] || [], count: (stageFiles[stageId] || []).length,
    }])),
    versions: {
      idea: latestVersion(ideas, PATTERNS.idea), research: latestVersion(syntheses, PATTERNS.synthesis),
      script: latestVersion(scripts, PATTERNS.script), assets: Math.max(latestVersion(plans, PATTERNS.assetPlan), latestVersion(blueprints, PATTERNS.editorialBlueprint)),
      audio: latestVersion(mixes, PATTERNS.audioMix), voice: latestVersion(voiceTakes, /voice_v(\d+)_take_\d+/i),
      music: latestVersion(musicTakes, /music_v(\d+)_take_\d+/i), qc: latestVersion(qc, PATTERNS.qc),
      package: latestVersion(metadata, PATTERNS.metadata),
    },
  };
}

function languageName(code = 'hi') {
  const normalized = String(code).toLowerCase();
  return ({ hi: 'hindi', en: 'english', sa: 'sanskrit' })[normalized.split('-')[0]] || normalized.replace(/[^a-z0-9-]/g, '') || 'hindi';
}

function iterationTarget(projectPath, stageId, language = 'hi', substage = null) {
  const scan = scanProject(projectPath);
  const versionKey = stageId === 'audio' && ['voice', 'music'].includes(substage) ? substage : stageId;
  let next = Number(scan.versions[versionKey] || 0) + 1;
  // A script revision is a bundle (outline → draft → fact-check → final), not
  // four unrelated global revisions. Increment each artifact family on its own
  // so the first complete bundle is consistently v1 across its files.
  if (stageId === 'script') {
    const scriptPatterns = {
      outline: /^02_script\/outline_v(\d+)_/i,
      draft: /^02_script\/draft_v(\d+)_/i,
      factcheck: PATTERNS.scriptFactcheck,
      author: /^02_script\/draft_v(\d+)_/i,
      review: /^02_script\/draft_v(\d+)_/i,
      final: PATTERNS.finalScript,
      analyze: /^02_script\/analysis_v(\d+)_/i,
      critic: /^02_script\/critique_v(\d+)_/i,
    };
    const pattern = scriptPatterns[substage] || scriptPatterns.draft;
    const candidates = [...scan.stages.script.files, ...walk(projectPath).filter((file) => /^02_script\/analysis_v\d+_/i.test(file))];
    next = latestVersion(candidates, pattern) + 1;
  }
  if (stageId === 'research' && substage === 'factcheck') {
    next = latestVersion(scan.stages.research.files, /^01_research\/factcheck_v(\d+)\.md$/i) + 1;
  }
  if (stageId === 'research' && substage === 'prepare') {
    const manifests = latestVersion(filesystemResearchFiles(projectPath), /^01_research\/manifest_v(\d+)\.json$/i);
    next = Math.max(scan.versions.research, manifests) + 1;
  }
  if (stageId === 'research' && substage === 'write') {
    const manifests = latestVersion(filesystemResearchFiles(projectPath), /^01_research\/manifest_v(\d+)\.json$/i);
    next = Math.max(manifests, scan.versions.research + 1);
  }
  if (stageId === 'research' && ['audit', 'remediate'].includes(substage)) {
    // These operate on the current written dossier; they are not a new research
    // cycle.  Their artifact version must line up with its claim ledger.
    next = Math.max(1, latestVersion(filesystemResearchFiles(projectPath), PATTERNS.synthesis));
  }
  if (stageId === 'qc' && substage === 'review') {
    next = latestVersion(walk(projectPath).filter((file) => /^05_edit\/quality_report_v\d+\.json$/i.test(file)), /^05_edit\/quality_report_v(\d+)\.json$/i) + 1;
  }
  const targets = {
    idea: `00_project/idea_v${next}.md`,
    research: substage === 'prepare' ? `01_research/manifest_v${next}.json`
      : substage === 'write' ? `01_research/dossiers/evidence_v${next}.md`
        : substage === 'audit' ? `01_research/verification/verification_v${next}.md`
          : substage === 'remediate' ? `01_research/remediation/remediation_v${next}.md`
            : substage === 'factcheck' ? `01_research/factcheck_v${next}.md`
              : `01_research/corpus/synthesis_v${next}.md`,
    script: substage === 'outline' ? `02_script/outline_v${next}_${languageName(language)}.md`
      : substage === 'factcheck' ? `02_script/factcheck_v${next}_${languageName(language)}.md`
      : substage === 'analyze' ? `02_script/analysis_v${next}_${languageName(language)}.md`
        : substage === 'critic' ? `02_script/critique_v${next}_${languageName(language)}.json`
        : substage === 'final' ? `02_script/final_v${next}_${languageName(language)}.md`
          : `02_script/draft_v${next}_${languageName(language)}.md`,
    assets: `04_visuals/plans/asset_plan_v${next}.json`,
    audio: substage === 'voice' ? `03_audio/takes/voice_v${next}_take_1.wav`
      : substage === 'music' ? `03_audio/music/music_v${next}_take_1.wav`
        : `03_audio/mixes/final_mix_v${next}.wav`,
    qc: substage === 'review' ? `05_edit/quality_report_v${next}.json` : `05_edit/qc_report_v${next}.json`,
    package: `06_publish/metadata_v${next}.json`,
  };
  return { version: next, target: targets[stageId] || null, scan };
}

function filesystemResearchFiles(projectPath) {
  return walk(projectPath).filter((file) => file.startsWith('01_research/'));
}

function ensureStructure(projectPath) {
  for (const directory of DIRECTORIES) fs.mkdirSync(path.join(projectPath, directory), { recursive: true });
  const manifest = path.join(projectPath, 'project.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { SCHEMA_VERSION, DIRECTORIES, PATTERNS, STAGE_DIRECTORIES, walk, scanProject, iterationTarget, languageName, ensureStructure };
