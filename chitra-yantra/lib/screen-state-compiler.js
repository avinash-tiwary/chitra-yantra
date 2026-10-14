'use strict';

/**
 * Turns an editorial (narrative) beat into short, executable screen states.
 * This is deliberately deterministic: an LLM chooses the package and its
 * editorial purpose once; templates turn that decision into reproducible
 * camera, overlay and Hyperframe instructions for assembly.
 */

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stateRecipe(beat, index, total) {
  const mode = beat.visual?.execution?.mode || 'ai_still';
  const purpose = String(beat.visual?.purpose || beat.narration?.anchor || 'Advance the narration.').trim();
  const overlay = String(beat.text?.overlay || '').trim();
  const phase = index === 0 ? 'establish' : index === total - 1 ? 'resolve' : 'develop';
  const recipes = {
    ai_still: [
      ['Establish the composition and the observed fact.', 'wide composition; no overlay'],
      ['Move to the decisive visual detail; preserve the ambiguity.', 'slow 12% push-in or detail crop'],
      [`Land the editorial contrast${overlay ? ` with “${overlay}”` : ''}.`, 'detail crop; restrained lower-third overlay'],
    ],
    hyperframe: [
      ['Reveal the active Hindi label or proposition.', 'base layout; active label enters'],
      ['Highlight the relevant relationship, source line, or branch.', 'focus highlight; prior layer dimmed'],
      [`Connect the relationship to the narration: ${purpose}`, 'arrow or path animates; conclusion label enters'],
    ],
    source_card: [
      ['Present the source identity and its claim boundary.', 'full source card; citation visible'],
      ['Zoom to the relevant line or image region.', 'crop to cited passage; highlight appears'],
      ['Translate the evidence into its limited editorial implication.', 'plain-language implication card; source remains visible'],
    ],
    typography: [
      ['State the active question or proposition.', 'centered type; quiet background'],
      ['Introduce the tension, counterpoint, or distinction.', 'second line enters; key word emphasized'],
      ['Resolve to the next question without overstating the evidence.', 'type reflows into the takeaway'],
    ],
    licensed_media: [
      ['Establish the licensed evidence in context.', 'wide crop; credit-safe framing'],
      ['Inspect the relevant factual detail.', 'slow crop or pan to the relevant region'],
      ['Return to narration with a concise, sourced implication.', 'hold detail; restrained caption'],
    ],
  };
  const options = recipes[mode] || recipes.ai_still;
  const selected = options[Math.min(index, options.length - 1)];
  return { phase, stateChange: selected[0], cropOrCamera: selected[1] };
}

function compileScreenStates(input, { maxStateSeconds = 3.5 } = {}) {
  if (!input || typeof input !== 'object') throw new Error('A blueprint object is required');
  if (!(maxStateSeconds > 0 && maxStateSeconds <= 4)) throw new Error('maxStateSeconds must be between 0 and 4 seconds');
  const blueprint = structuredClone(input);
  const states = [];
  for (const beat of blueprint.beats || []) {
    const start = number(beat.timing?.startSeconds);
    const end = number(beat.timing?.endSeconds);
    const duration = end - start;
    if (!(duration > 0)) continue;
    const count = Math.max(1, Math.ceil(duration / maxStateSeconds));
    const length = duration / count;
    for (let index = 0; index < count; index += 1) {
      const recipe = stateRecipe(beat, index, count);
      const stateStart = Number((start + length * index).toFixed(3));
      const stateEnd = Number((index === count - 1 ? end : start + length * (index + 1)).toFixed(3));
      const baseVariant = beat.visual?.execution?.variantId || beat.id;
      states.push({
        id: `${beat.id}_S${String(index + 1).padStart(2, '0')}`,
        parentBeatId: beat.id,
        timing: { startSeconds: stateStart, endSeconds: stateEnd },
        visual: {
          type: beat.visual?.type,
          primaryAssetId: beat.visual?.primaryAssetId,
          execution: {
            mode: beat.visual?.execution?.mode,
            variantId: `${baseVariant}_S${index + 1}`,
            stateChange: recipe.stateChange,
            cropOrCamera: recipe.cropOrCamera,
          },
          motion: beat.visual?.motion,
          transitionIn: index === 0 ? beat.visual?.transitionIn : 'clean_cut',
          transitionOut: index === count - 1 ? beat.visual?.transitionOut : 'clean_cut',
        },
        text: {
          overlay: index === count - 1 ? beat.text?.overlay || '' : '',
          citation: beat.text?.citation || '',
          aiDisclosure: Boolean(beat.text?.aiDisclosure),
        },
        audio: {
          musicCueId: beat.audio?.musicCueId || null,
          sfx: index === 0 ? beat.audio?.sfx || [] : [],
          narrationPriority: beat.audio?.narrationPriority || 'full',
        },
        assembly: { phase: recipe.phase, generatedBy: 'screen-state-compiler-v1' },
      });
    }
  }
  blueprint.screenStates = states;
  blueprint.screenStatePlan = { compiler: 'screen-state-compiler-v1', maxStateSeconds, generatedAt: new Date().toISOString() };
  return blueprint;
}

module.exports = { compileScreenStates };
