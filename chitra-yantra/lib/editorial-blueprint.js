'use strict';

/**
 * Editorial Blueprint is the production contract between an approved script and
 * the audio, visual, and assembly stages.  The flat asset plan is deliberately
 * retained because local image tooling consumes it directly.
 */

const MOTION_TYPES = new Set(['hold', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'parallax', 'map_route', 'text_reveal', 'diagram_build']);
const VISUAL_TYPES = new Set(['ai_generated', 'cleared_archive', 'government_open', 'cc_compatible', 'map', 'photo', 'artwork', 'text_card', 'motion_graphic', 'comparison', 'black']);
const EXECUTION_MODES = new Set(['ai_still', 'hyperframe', 'source_card', 'typography', 'licensed_media']);
const SELF_PRODUCED_SOURCE_KINDS = new Set(['ai_generated', 'original_motion_graphic', 'hyperframe', 'source_card', 'typography']);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function planVersion(file = '') {
  return Number(String(file).match(/_v(\d+)\.json$/i)?.[1] || 0);
}

function assetId(asset, index) {
  return asset?.id || `ASSET_${String(index + 1).padStart(3, '0')}`;
}

function hasScheduledInternalStates(stateChange, duration) {
  const timestamps = [...String(stateChange || '').matchAll(/(?:^|[^\d])(\d+(?:\.\d+)?)s\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && value < duration)
    .sort((left, right) => left - right);
  const states = [0, ...timestamps, duration];
  return states.every((value, index) => index === 0 || value - states[index - 1] <= 4);
}

function compiledStatesForBeat(blueprint, beat) {
  return (blueprint.screenStates || [])
    .filter((state) => state?.parentBeatId === beat.id)
    .sort((left, right) => number(left.timing?.startSeconds) - number(right.timing?.startSeconds));
}

function hasCompiledCadence(blueprint, beat) {
  const states = compiledStatesForBeat(blueprint, beat);
  if (!states.length) return false;
  const start = number(beat.timing?.startSeconds, -1);
  const end = number(beat.timing?.endSeconds, -1);
  let cursor = start;
  for (const state of states) {
    const stateStart = number(state.timing?.startSeconds, -1);
    const stateEnd = number(state.timing?.endSeconds, -1);
    if (Math.abs(stateStart - cursor) > 0.051 || stateEnd <= stateStart || stateEnd - stateStart > 4.001) return false;
    cursor = stateEnd;
  }
  return Math.abs(cursor - end) <= 0.051;
}

function makeLegacyBlueprint(assetPlan = [], { title = 'Editorial blueprint', version = 1, durationSeconds = 0 } = {}) {
  const assets = Array.isArray(assetPlan) ? assetPlan : [];
  const defaultDuration = durationSeconds > 0 ? durationSeconds / Math.max(assets.length, 1) : 5;
  let cursor = 0;
  return {
    schemaVersion: 1,
    title,
    version,
    timing: { basis: 'script_estimate', targetDurationSeconds: Math.round(durationSeconds || assets.length * defaultDuration), reconciledAt: null },
    creativeDirection: {
      channelMode: 'faceless',
      palette: ['midnight indigo', 'sandstone', 'oxidized copper', 'manuscript ivory'],
      visualRhythm: 'A meaningful visual change every 2–6 seconds; intentional holds require a reason.',
    },
    assets: assets.map((asset, index) => ({
      ...asset,
      id: assetId(asset, index),
      sourceKind: asset.sourceKind || (String(asset.type || '').toUpperCase() === 'GEN' ? 'ai_generated' : 'cleared_archive'),
      production: {
        brief: asset.description || '',
        generationPrompt: String(asset.type || '').toUpperCase() === 'GEN' ? (asset.prompt || asset.description || '') : '',
        negativePrompt: '', aspectRatio: '16:9', framing: '', lighting: '',
        collectionBrief: String(asset.type || '').toUpperCase() === 'GEN' ? '' : (asset.sourceSuggestion || ''),
        searchQueries: [], preferredCollections: [], requiredEvidence: '',
        ...(asset.production || {}),
      },
    })),
    beats: assets.map((asset, index) => {
      const startSeconds = Number(cursor.toFixed(3));
      cursor += defaultDuration;
      return {
        id: `BEAT_${String(index + 1).padStart(3, '0')}`,
        narration: { anchor: asset.description || `Visual beat ${index + 1}`, scriptLines: [] },
        timing: { startSeconds, endSeconds: Number(cursor.toFixed(3)), basis: 'script_estimate' },
        visual: {
          type: String(asset.type || 'GEN').toUpperCase() === 'GEN' ? 'ai_generated' : 'cleared_archive',
          primaryAssetId: assetId(asset, index),
          execution: { mode: String(asset.type || 'GEN').toUpperCase() === 'GEN' ? 'ai_still' : 'licensed_media', variantId: `legacy_${index + 1}`, stateChange: 'Legacy asset segment.', cropOrCamera: 'full frame' },
          purpose: 'Illustrate the narration',
          motion: { type: 'push_in', intensity: 'subtle', rationale: 'Reveal detail without leaving a static frame.' },
          transitionIn: index ? 'crossfade' : 'cut',
          transitionOut: 'crossfade',
        },
        text: { overlay: '', citation: '', aiDisclosure: String(asset.type || '').toUpperCase() === 'GEN' },
    audio: { musicCueId: null, musicBrief: '', sfx: [], sfxBrief: '', silenceSeconds: 0, narrationPriority: true },
        source: { status: asset.sourceUrl ? 'cleared' : 'needs_review', url: asset.sourceUrl || null, license: asset.license || null, attribution: asset.attribution || null },
        status: 'draft',
      };
    }),
  };
}

function normaliseBlueprint(raw, fallback = {}) {
  if (Array.isArray(raw)) return makeLegacyBlueprint(raw, fallback);
  if (!raw || typeof raw !== 'object') return makeLegacyBlueprint([], fallback);
  const blueprint = structuredClone(raw);
  blueprint.schemaVersion = number(blueprint.schemaVersion, 1);
  blueprint.version = number(blueprint.version, fallback.version || 1);
  blueprint.title = String(blueprint.title || fallback.title || 'Editorial blueprint');
  blueprint.timing = { basis: 'script_estimate', targetDurationSeconds: 0, reconciledAt: null, ...(blueprint.timing || {}) };
  blueprint.creativeDirection = { channelMode: 'faceless', ...(blueprint.creativeDirection || {}) };
  blueprint.assets = Array.isArray(blueprint.assets) ? blueprint.assets.map((asset, index) => {
    const isObject = Boolean(asset) && typeof asset === 'object' && !Array.isArray(asset);
    const value = isObject ? asset : {};
    return {
      ...value,
      id: assetId(value, index),
      invalidAssetReference: Boolean(value.invalidAssetReference) || !isObject,
      sourceKind: value.sourceKind || (String(value.type || '').toUpperCase() === 'GEN' ? 'ai_generated' : 'cleared_archive'),
      production: { brief: value.description || '', generationPrompt: value.prompt || '', negativePrompt: '', aspectRatio: '16:9', framing: '', lighting: '', collectionBrief: value.sourceSuggestion || '', searchQueries: [], preferredCollections: [], requiredEvidence: '', ...(value.production || {}) },
    };
  }) : [];
  blueprint.beats = Array.isArray(blueprint.beats) ? blueprint.beats.map((beat, index) => ({
    ...beat,
    id: beat.id || `BEAT_${String(index + 1).padStart(3, '0')}`,
    narration: { anchor: '', scriptLines: [], ...(beat.narration || {}) },
    timing: { startSeconds: 0, endSeconds: 0, basis: blueprint.timing.basis, ...(beat.timing || {}) },
    visual: { type: 'ai_generated', primaryAssetId: null, execution: { mode: '', variantId: '', stateChange: '', cropOrCamera: '' }, purpose: '', motion: { type: 'hold', intensity: 'subtle', rationale: '' }, transitionIn: 'crossfade', transitionOut: 'crossfade', ...(beat.visual || {}) },
    text: { overlay: '', citation: '', aiDisclosure: false, ...(beat.text || {}) },
    audio: { musicCueId: null, musicBrief: '', sfx: [], sfxBrief: '', silenceSeconds: 0, narrationPriority: true, ...(beat.audio || {}) },
    source: { status: 'needs_review', url: null, license: null, attribution: null, ...(beat.source || {}) },
    status: beat.status || 'draft',
  })) : [];
  blueprint.screenStates = Array.isArray(blueprint.screenStates) ? blueprint.screenStates.map((state, index) => ({
    ...state,
    id: state?.id || `STATE_${String(index + 1).padStart(3, '0')}`,
    parentBeatId: String(state?.parentBeatId || ''),
    timing: { startSeconds: 0, endSeconds: 0, ...(state?.timing || {}) },
  })) : [];
  return blueprint;
}

function deriveAssetPlan(blueprint) {
  const normalised = normaliseBlueprint(blueprint);
  return normalised.assets.map((asset, index) => ({
    id: assetId(asset, index),
    type: String(asset.type || (asset.sourceKind === 'ai_generated' ? 'GEN' : 'PHOTO')).toUpperCase(),
    description: asset.description || '',
    prompt: asset.prompt || asset.description || '',
    generatedPath: asset.generatedPath || null,
    sourceUrl: asset.sourceUrl || asset.source?.url || null,
    license: asset.license || asset.source?.license || null,
    attribution: asset.attribution || asset.source?.attribution || null,
    sourceSuggestion: asset.sourceSuggestion || null,
    resolution: asset.resolution || null,
    upscaled: Boolean(asset.upscaled),
    approvalStatus: asset.approvalStatus || 'pending',
    sourceKind: asset.sourceKind || (String(asset.type || '').toUpperCase() === 'GEN' ? 'ai_generated' : 'cleared_archive'),
  }));
}

function validateBlueprint(input) {
  const blueprint = normaliseBlueprint(input);
  const problems = [];
  for (const [index, asset] of blueprint.assets.entries()) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || asset.invalidAssetReference || !String(asset.id || '').trim()) {
      problems.push({ severity: 'blocking', beatId: null, message: `Asset ${index + 1} must be a complete object with an id, not an asset reference.` });
    }
  }
  const assetIds = new Set(blueprint.assets.map((asset) => asset.id));
  let previousEnd = 0;
  for (const [index, beat] of blueprint.beats.entries()) {
    const label = beat.id || `beat ${index + 1}`;
    const start = number(beat.timing.startSeconds, -1);
    const end = number(beat.timing.endSeconds, -1);
    if (!beat.narration.anchor.trim()) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} has no narration anchor.` });
    if (start < 0 || end <= start) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} has an invalid timing range.` });
    if (index === 0 && start > 0.05) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} does not begin at the start of the narration.` });
    if (start + 0.05 < previousEnd) problems.push({ severity: 'warning', beatId: beat.id, message: `${label} overlaps the preceding beat.` });
    if (index > 0 && start - previousEnd > 0.05) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} leaves an uncovered narration gap.` });
    previousEnd = Math.max(previousEnd, end);
    const duration = end - start;
    if (blueprint.schemaVersion >= 2 && duration > 4 && !hasCompiledCadence(blueprint, beat) && !hasScheduledInternalStates(beat.visual?.execution?.stateChange, duration)) {
      problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} is ${Number(duration.toFixed(1))} seconds; split it or schedule timestamped internal screen states every 2–4 seconds.` });
    }
    if (duration > 8 && !beat.visual?.holdRationale && !beat.visual?.motion?.rationale) problems.push({ severity: 'warning', beatId: beat.id, message: `${label} holds longer than 8 seconds without an editorial rationale.` });
    if (duration > 12) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} exceeds the 12-second faceless visual hold limit.` });
    if (!VISUAL_TYPES.has(beat.visual?.type)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} has an unsupported visual type.` });
    if (!MOTION_TYPES.has(beat.visual?.motion?.type)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} has an unsupported motion directive.` });
    if (beat.visual?.primaryAssetId && !assetIds.has(beat.visual.primaryAssetId)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} references a missing asset.` });
    const asset = blueprint.assets.find((item) => item.id === beat.visual?.primaryAssetId);
    const usesAi = beat.visual?.type === 'ai_generated' || asset?.sourceKind === 'ai_generated';
    const execution = beat.visual?.execution || {};
    if (blueprint.schemaVersion >= 2) {
      if (!EXECUTION_MODES.has(execution.mode)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} has no supported execution mode.` });
      if (!String(execution.variantId || '').trim() || !String(execution.stateChange || '').trim() || !String(execution.cropOrCamera || '').trim()) {
        problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} lacks a visible execution variant, state change, or framing instruction.` });
      }
    }
    if (usesAi && !beat.text?.aiDisclosure) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} uses an AI reconstruction without an on-screen disclosure.` });
    const sourceStatus = beat.source?.status;
    const selfProduced = usesAi || SELF_PRODUCED_SOURCE_KINDS.has(asset?.sourceKind);
    if (selfProduced && sourceStatus !== 'not_applicable') problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} is self-produced and must use not_applicable source rights.` });
    if (!selfProduced && !['cleared', 'not_applicable'].includes(sourceStatus)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} lacks cleared source rights.` });
    if (!usesAi && sourceStatus === 'cleared' && (!beat.source?.url || !beat.source?.license || !beat.source?.attribution)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${label} is marked cleared without source URL, license, and attribution.` });
  }
  if (blueprint.schemaVersion >= 2) {
    const variants = new Set();
    for (const beat of blueprint.beats) {
      const key = `${beat.visual?.primaryAssetId || ''}:${beat.visual?.execution?.variantId || ''}`;
      if (variants.has(key)) problems.push({ severity: 'blocking', beatId: beat.id, message: `${beat.id} repeats an asset variant; specify a visibly different state.` });
      variants.add(key);
    }
  }
  if (!blueprint.beats.length) problems.push({ severity: 'blocking', beatId: null, message: 'The blueprint has no planned beats.' });
  return problems;
}

function summary(input) {
  const blueprint = normaliseBlueprint(input);
  const problems = validateBlueprint(blueprint);
  const beats = blueprint.beats;
  const duration = Math.max(0, ...beats.map((beat) => number(beat.timing.endSeconds)));
  const intervals = beats.map((beat) => number(beat.timing.endSeconds) - number(beat.timing.startSeconds)).filter((value) => value > 0);
  const cadenceRisks = beats.filter((beat) => {
    const duration = number(beat.timing.endSeconds) - number(beat.timing.startSeconds);
    return duration > 4 && !hasCompiledCadence(blueprint, beat) && !hasScheduledInternalStates(beat.visual?.execution?.stateChange, duration);
  }).length;
  return {
    totalBeats: beats.length,
    durationSeconds: Math.round(duration),
    averageVisualSeconds: intervals.length ? Number((intervals.reduce((sum, value) => sum + value, 0) / intervals.length).toFixed(1)) : 0,
    cadenceRisks,
    screenStates: blueprint.screenStates.length,
    approvedBeats: beats.filter((beat) => beat.status === 'approved').length,
    aiReconstructions: beats.filter((beat) => beat.visual?.type === 'ai_generated').length,
    clearedSources: beats.filter((beat) => beat.source?.status === 'cleared').length,
    blocking: problems.filter((problem) => problem.severity === 'blocking').length,
    warnings: problems.filter((problem) => problem.severity === 'warning').length,
    timingBasis: blueprint.timing.basis,
  };
}

module.exports = { MOTION_TYPES, VISUAL_TYPES, EXECUTION_MODES, planVersion, makeLegacyBlueprint, normaliseBlueprint, deriveAssetPlan, validateBlueprint, summary };
