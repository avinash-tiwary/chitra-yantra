'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assertStageAndSubstage } = require('../lib/stages');
const { PATTERNS, iterationTarget } = require('../lib/project-schema');
const { buildAdapter } = require('../lib/adapters');

// Extract findLatestScriptArtifact from public/app.js
const appJsPath = path.resolve(__dirname, '..', 'public', 'app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

function extractFunction(name) {
  const regex = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const match = appJsContent.match(regex);
  if (!match) throw new Error(`Could not find function ${name} in app.js`);
  return new Function(`${match[0]}; return ${name};`)();
}

const findLatestScriptArtifact = extractFunction('findLatestScriptArtifact');

test('findLatestScriptArtifact prioritizes final > draft/script > factcheck > outline', () => {
  const artifacts = [
    { relativePath: '02_script/outline_v1_hindi.md', revision: 1, stageId: 'script' },
    { relativePath: '02_script/draft_v1_hindi.md', revision: 2, stageId: 'script' },
    { relativePath: '02_script/factcheck_report.md', revision: 1, stageId: 'script' },
  ];

  // Draft should take precedence over outline and factcheck
  let chosen = findLatestScriptArtifact(artifacts);
  assert.equal(chosen.relativePath, '02_script/draft_v1_hindi.md');

  // Add final script - it must take top priority
  artifacts.push({ relativePath: '02_script/final_v1_hindi.md', revision: 3, stageId: 'script' });
  chosen = findLatestScriptArtifact(artifacts);
  assert.equal(chosen.relativePath, '02_script/final_v1_hindi.md');

  // If only outline exists, it selects outline
  const outlineOnly = [{ relativePath: '02_script/outline_v1_hindi.md', revision: 1, stageId: 'script' }];
  assert.equal(findLatestScriptArtifact(outlineOnly).relativePath, '02_script/outline_v1_hindi.md');
});

test('findLatestScriptArtifact respects version numbering', () => {
  const artifacts = [
    { relativePath: '02_script/draft_v1_hindi.md', revision: 1, stageId: 'script' },
    { relativePath: '02_script/draft_v2_hindi.md', revision: 1, stageId: 'script' },
  ];
  const chosen = findLatestScriptArtifact(artifacts);
  assert.equal(chosen.relativePath, '02_script/draft_v2_hindi.md');
});

test('PATTERNS.script matches script, outline, draft, and final filenames', () => {
  assert.ok(PATTERNS.script.test('02_script/script_v1_hindi.md'));
  assert.ok(PATTERNS.script.test('02_script/outline_v1_hindi.md'));
  assert.ok(PATTERNS.script.test('02_script/draft_v2_english.md'));
  assert.ok(PATTERNS.script.test('02_script/final_v3_hindi.md'));
  assert.ok(!PATTERNS.script.test('02_script/notes.txt'));
});

test('script stage supports analyze substage alongside standard substages', () => {
  const draft = assertStageAndSubstage('script', 'draft');
  assert.equal(draft.substage, 'draft');

  const factcheck = assertStageAndSubstage('script', 'factcheck');
  assert.equal(factcheck.substage, 'factcheck');

  const analyze = assertStageAndSubstage('script', 'analyze');
  assert.equal(analyze.substage, 'analyze');
});

test('iterationTarget calculates analysis output target', () => {
  const tempProject = path.join(__dirname, '..', 'channels', 'example-channel', 'videos', 'test-video');
  const target = iterationTarget(tempProject, 'script', 'hi', 'analyze');
  assert.ok(target.target.includes('02_script/analysis_v1_hindi.md'));
});

test('buildAdapter for script/analyze generates prompt pointing to parentArtifact', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const projectPath = path.resolve(projectRoot, 'channels', 'example-channel', 'videos', 'video-2026-09-14-1006');
  const spec = buildAdapter({
    appRoot: projectRoot,
    projectRoot,
    projectPath,
    project: {
      title: 'नालंदा जला, पर वेद क्यों नहीं जले?',
      channelId: 'example-channel',
      settings: { language: 'hi', targetDurationMin: 12 },
      stages: {},
    },
    channel: { name: 'मीमांसा', script_language: 'hi' },
    stageId: 'script',
    substage: 'analyze',
    adapter: 'codex',
    parentArtifact: '02_script/outline_v1_hindi.md',
  });

  assert.ok(spec.prompt.includes('Script to Analyze:'));
  assert.ok(spec.prompt.includes('outline_v1_hindi.md'), 'Prompt should reference parentArtifact');
  assert.ok(spec.prompt.includes('Critical script analysis') || spec.prompt.includes('critical script analysis'));
});

test('English script drafts use the English outline and canonical-authoring instructions', (t) => {
  const projectRoot = path.resolve(__dirname, '..');
  const projectPath = fs.mkdtempSync(path.join(__dirname, 'script-language-'));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectPath, '02_script'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '02_script', 'outline_v1_english.md'), '# English outline\n'.repeat(30));
  fs.writeFileSync(path.join(projectPath, '02_script', 'outline_v1_hindi.md'), '# Hindi outline\n'.repeat(30));

  const spec = buildAdapter({
    appRoot: projectRoot,
    projectRoot,
    projectPath,
    project: {
      title: 'How Do We Know?',
      channelId: 'example-channel',
      settings: { language: 'en', targetDurationMin: 12 },
      stages: {},
    },
    channel: { name: 'Example Channel', script_language: 'hi' },
    stageId: 'script',
    substage: 'draft',
    adapter: 'codex',
    outputTarget: '02_script/draft_v1_english.md',
  });

  assert.ok(spec.prompt.includes('Output language: English'));
  assert.ok(spec.prompt.includes('English authoring script'));
  assert.ok(spec.prompt.includes('outline_v1_english.md'));
  assert.ok(!spec.prompt.includes('outline_v1_hindi.md'));
});
