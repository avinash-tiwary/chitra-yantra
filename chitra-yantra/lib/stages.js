'use strict';

const STAGES = Object.freeze([
  {
    id: 'idea', name: 'Idea', description: 'Frame the question and choose a direction.', estimatedMin: 5,
    substages: ['generate'], requires: [], outputs: [], convention: '00_project/idea_v{n}.md', iterative: true,
  },
  {
    id: 'research', name: 'Research', description: 'Plan parallel investigations, synthesize them, and verify the resulting claims.', estimatedMin: 45,
    // Angle and synthesis substages are generated dynamically from the plan.
    // Keeping only the two boundary stages here prevents generic automation
    // from trying to linearize the fan-out/fan-in research pipeline.
    substages: ['plan', 'verify'], requires: ['idea'], outputs: [], convention: '01_research/research_pipeline_v{n}.json + dossiers/**', iterative: true,
  },
  {
    id: 'script', name: 'Script', description: 'Outline, draft, verify, and lock narration.', estimatedMin: 60,
    // `critic` is deliberately a separate pass: it creates a verdict and a
    // revision brief, but never rewrites the script it assesses.
    substages: ['author', 'outline', 'draft', 'review', 'analyze', 'factcheck', 'critic'], requires: ['research'],
    outputs: [], convention: '02_script/draft_v{n}_{language}.md', iterative: true,
  },
  {
    id: 'assets', name: 'Editorial blueprint', description: 'Turn the approved script into a timed, rights-aware audiovisual plan.', estimatedMin: 25,
    substages: ['extract'], requires: ['script'], outputs: [], convention: '04_visuals/plans/editorial_blueprint_v{n}.json + asset_plan_v{n}.json', iterative: true,
  },
  {
    id: 'audio', name: 'Audio', description: 'Generate narration and the blueprint’s original score, then mix.', estimatedMin: 45,
    substages: ['voice', 'music', 'mix'], requires: ['assets'], outputs: [], convention: '03_audio/takes/** + mixes/final_mix_v{n}.wav', iterative: true,
  },
  {
    id: 'visuals', name: 'Visuals', description: 'Produce and approve every visual asset.', estimatedMin: 45,
    substages: ['generate'], requires: ['assets'], outputs: [], convention: '04_visuals/renders/**',
  },
  {
    id: 'assembly', name: 'Assembly', description: 'Build a deterministic review export.', estimatedMin: 20,
    substages: ['assemble'], requires: ['audio', 'visuals'], outputs: ['05_edit/review_exports/assembled_v01.mp4'],
  },
  {
    id: 'qc', name: 'Quality check', description: 'Verify technical and editorial release gates.', estimatedMin: 10,
    substages: ['inspect', 'review'], requires: ['assembly'], outputs: [], convention: '05_edit/qc_report_v{n}.json + quality_report_v{n}.json',
  },
  {
    id: 'package', name: 'Package', description: 'Prepare title, description, chapters, and artwork.', estimatedMin: 10,
    substages: ['metadata', 'subtitles'], requires: ['qc'], outputs: [], convention: '06_publish/metadata_v{n}.json',
  },
  {
    id: 'publish', name: 'Release', description: 'Upload a qualified private candidate; only the owner may release it.', estimatedMin: 10,
    substages: ['upload_candidate'], requires: ['package'], outputs: [],
  },
]);

const STAGE_IDS = new Set(STAGES.map((stage) => stage.id));

function getStage(stageId) {
  return STAGES.find((stage) => stage.id === stageId) || null;
}

function assertStageAndSubstage(stageId, substage) {
  const stage = getStage(stageId);
  if (!stage) throw Object.assign(new Error(`Unknown stage: ${stageId}`), { statusCode: 400 });
  let selected = substage || stage.substages[0];
  if (stageId === 'visuals' && selected === 'render') {
    selected = 'generate';
  }
  // Dynamic research jobs are private orchestration tasks. Legacy operations
  // remain callable for existing workspaces, but are no longer the default.
  const dynamicResearch = stageId === 'research' && /^(?:angle-[0-9]{2}|synthesize-[1-3])$/.test(selected);
  const legacyResearch = stageId === 'research' && ['research', 'factcheck', 'prepare', 'write', 'audit', 'remediate'].includes(selected);
  if (!stage.substages.includes(selected) && !dynamicResearch && !legacyResearch) {
    throw Object.assign(new Error(`Unknown ${stageId} substage: ${selected}`), { statusCode: 400 });
  }
  return { stage, substage: selected };
}

module.exports = { STAGES, STAGE_IDS, getStage, assertStageAndSubstage };
