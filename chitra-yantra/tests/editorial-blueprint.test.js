'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLegacyBlueprint, normaliseBlueprint, deriveAssetPlan, validateBlueprint, summary } = require('../lib/editorial-blueprint');
const { compileScreenStates } = require('../lib/screen-state-compiler');

test('legacy asset plans receive a reviewable faceless Editorial Blueprint', () => {
  const blueprint = makeLegacyBlueprint([{ id: 'ASSET_001', type: 'GEN', description: 'Example Topic at dawn', prompt: 'period reconstruction' }], { title: 'Example Topic', durationSeconds: 60 });
  assert.equal(blueprint.beats.length, 1);
  assert.equal(blueprint.beats[0].text.aiDisclosure, true);
  assert.equal(blueprint.beats[0].visual.motion.type, 'push_in');
  assert.equal(summary(blueprint).durationSeconds, 60);
});

test('blueprint validation blocks unlabelled AI and uncleared real-world evidence', () => {
  const blueprint = normaliseBlueprint({
    assets: [{ id: 'A1', type: 'GEN', description: 'scene', sourceKind: 'ai_generated' }],
    beats: [{ id: 'B1', narration: { anchor: 'A claim' }, timing: { startSeconds: 0, endSeconds: 5 }, visual: { type: 'ai_generated', primaryAssetId: 'A1', motion: { type: 'push_in' } }, text: { aiDisclosure: false }, source: { status: 'not_applicable' } }],
  });
  assert.match(validateBlueprint(blueprint).map((problem) => problem.message).join('\n'), /AI reconstruction without an on-screen disclosure/);
  blueprint.beats[0].text.aiDisclosure = true;
  assert.equal(validateBlueprint(blueprint).filter((problem) => problem.severity === 'blocking').length, 0);
});

test('blueprint validation rejects an asset-ID list in place of complete assets', () => {
  const blueprint = normaliseBlueprint({
    assets: ['A01'],
    beats: [{ id: 'B1', narration: { anchor: 'A claim' }, timing: { startSeconds: 0, endSeconds: 5 }, visual: { type: 'ai_generated', primaryAssetId: 'A01', motion: { type: 'push_in', rationale: 'Introduce the scene.' } }, text: { aiDisclosure: true }, source: { status: 'not_applicable' } }],
  });
  assert.match(validateBlueprint(blueprint).map((problem) => problem.message).join('\n'), /complete object with an id, not an asset reference/);
});

test('schema v2 requires distinct visible variants and accepts self-produced Hyperframes', () => {
  const blueprint = normaliseBlueprint({
    schemaVersion: 2,
    assets: [{ id: 'H01', type: 'ART', sourceKind: 'hyperframe', description: 'Inference ladder' }],
    beats: [
      { id: 'B1', narration: { anchor: 'Claim' }, timing: { startSeconds: 0, endSeconds: 4 }, visual: { type: 'motion_graphic', primaryAssetId: 'H01', execution: { mode: 'hyperframe', variantId: 'claim', stateChange: 'Claim appears', cropOrCamera: 'full frame' }, motion: { type: 'diagram_build', rationale: 'Start the sequence.' } }, source: { status: 'not_applicable' } },
      { id: 'B2', narration: { anchor: 'Sign' }, timing: { startSeconds: 4, endSeconds: 8 }, visual: { type: 'motion_graphic', primaryAssetId: 'H01', execution: { mode: 'hyperframe', variantId: 'sign', stateChange: 'Sign is highlighted', cropOrCamera: 'medium crop' }, motion: { type: 'diagram_build', rationale: 'Advance the sequence.' } }, source: { status: 'not_applicable' } },
    ],
  });
  assert.equal(validateBlueprint(blueprint).filter((problem) => problem.severity === 'blocking').length, 0);
  blueprint.beats[1].visual.execution.variantId = 'claim';
  assert.match(validateBlueprint(blueprint).map((problem) => problem.message).join('\n'), /repeats an asset variant/);
});

test('schema v2 flags a visual beat that exceeds four seconds without a scheduled state change', () => {
  const blueprint = normaliseBlueprint({
    schemaVersion: 2,
    assets: [{ id: 'A1', type: 'GEN', sourceKind: 'ai_generated', description: 'scene' }],
    beats: [{ id: 'B1', narration: { anchor: 'Claim' }, timing: { startSeconds: 0, endSeconds: 5 }, visual: { type: 'ai_generated', primaryAssetId: 'A1', execution: { mode: 'ai_still', variantId: 'wide', stateChange: 'Scene appears', cropOrCamera: 'wide' }, motion: { type: 'push_in', rationale: 'Set the scene.' } }, text: { aiDisclosure: true }, source: { status: 'not_applicable' } }],
  });
  assert.match(validateBlueprint(blueprint).map((problem) => problem.message).join('\n'), /timestamped internal screen states every 2–4 seconds/);
  assert.equal(summary(blueprint).cadenceRisks, 1);
  blueprint.beats[0].visual.execution.stateChange = '0.0s scene appears → 2.5s key detail highlighted → 5.0s cut';
  assert.doesNotMatch(validateBlueprint(blueprint).map((problem) => problem.message).join('\n'), /timestamped internal screen states/);
  assert.equal(summary(blueprint).cadenceRisks, 0);
});

test('screen-state compiler deterministically covers long beats with executable sub-four-second states', () => {
  const source = {
    schemaVersion: 2,
    assets: [{ id: 'H1', type: 'ART', sourceKind: 'hyperframe', description: 'Inference ladder' }],
    beats: [{ id: 'B1', narration: { anchor: 'Claim' }, timing: { startSeconds: 0, endSeconds: 7.2 }, visual: { type: 'motion_graphic', primaryAssetId: 'H1', execution: { mode: 'hyperframe', variantId: 'ladder', stateChange: 'Generic state', cropOrCamera: 'full frame' }, motion: { type: 'diagram_build', rationale: 'Build the relationship.' } }, source: { status: 'not_applicable' } }],
  };
  const compiled = compileScreenStates(source);
  assert.equal(compiled.screenStates.length, 3);
  assert.deepEqual(compiled.screenStates.map((state) => [state.timing.startSeconds, state.timing.endSeconds]), [[0, 2.4], [2.4, 4.8], [4.8, 7.2]]);
  assert.match(compiled.screenStates[1].visual.execution.stateChange, /Highlight/);
  assert.equal(summary(compiled).cadenceRisks, 0);
  assert.equal(validateBlueprint(compiled).filter((problem) => problem.severity === 'blocking').length, 0);
});

test('the derived renderer catalog remains a flat compatible array', () => {
  const catalog = deriveAssetPlan({ assets: [{ id: 'ASSET_001', sourceKind: 'ai_generated', description: 'Scene', prompt: 'Prompt', approvalStatus: 'approved' }], beats: [] });
  assert.equal(Array.isArray(catalog), true);
  assert.deepEqual(catalog[0], {
    id: 'ASSET_001', type: 'GEN', description: 'Scene', prompt: 'Prompt', generatedPath: null,
    sourceUrl: null, license: null, attribution: null, sourceSuggestion: null, resolution: null,
    upscaled: false, approvalStatus: 'approved', sourceKind: 'ai_generated',
  });
});
