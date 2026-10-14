'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResearchPipelineController, normalizedPlan } = require('../lib/research-pipeline');
const { JobManager } = require('../lib/jobs');

function validPlan(angleCount = 4, synthesisPasses = 3) {
  return {
    schemaVersion: 1,
    topic: 'Why did the campaign stop?',
    pitch: 'Treat the popular explanation as a hypothesis.',
    rationale: 'The evidence is broad and contested.',
    synthesisPasses,
    angles: Array.from({ length: angleCount }, (_, index) => ({
      title: `Angle ${index + 1}`,
      objective: `Establish dimension ${index + 1}`,
      questions: [`What does evidence stream ${index + 1} establish?`],
      sourceStrategy: ['Prefer direct and scholarly sources'],
      boundaries: ['Avoid duplicating other evidence streams'],
      priority: index === 0 ? 'high' : 'medium',
      risk: 'medium',
    })),
  };
}

test('adaptive research fans out planned angles, runs selected synthesis passes, and verifies last', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-research-pipeline-'));
  try {
    let project = {
      projectKey: 'demo__video', settings: { defaultAgent: 'codex', researchMaxAngles: 10, researchMaxSynthesisPasses: 3 },
      stages: { research: { status: 'ready', data: {} } },
    };
    const queued = [];
    const store = {
      patchStage: (_key, _stage, patch) => {
        project = { ...project, stages: { ...project.stages, research: {
          ...project.stages.research,
          status: patch.status || project.stages.research.status,
          data: patch.data ? { ...project.stages.research.data, ...patch.data } : project.stages.research.data,
        } } };
        return project.stages.research;
      },
    };
    const controller = new ResearchPipelineController({
      store,
      getProject: () => project,
      projectPathForKey: () => root,
      queueStage: (task) => { const run = { id: `run-${queued.length + 1}` }; queued.push({ ...task, run }); return run; },
    });

    const started = controller.start({ projectKey: project.projectKey, adapter: 'codex' });
    assert.equal(started.run.id, 'run-1');
    assert.equal(queued[0].substage, 'plan');
    const planFile = path.join(root, started.pipeline.planPath);
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `\`\`\`json\n${JSON.stringify(validPlan())}\n\`\`\`\n`);
    const terminal = (substage, status = 'needs_review') => controller.onJob({
      id: queued.findLast((item) => item.substage === substage).run.id,
      projectKey: project.projectKey,
      stageId: 'research',
      substage,
      status,
    });

    const planned = terminal('plan');
    assert.equal(planned.handled, true);
    assert.deepEqual(queued.slice(1).map((item) => item.substage), ['angle-01', 'angle-02', 'angle-03', 'angle-04']);

    for (let index = 1; index <= 4; index++) {
      terminal(`angle-${String(index).padStart(2, '0')}`);
    }
    assert.equal(queued.at(-1).substage, 'synthesize-1');
    terminal('synthesize-1');
    assert.equal(queued.at(-1).substage, 'synthesize-2');
    terminal('synthesize-2');
    assert.equal(queued.at(-1).substage, 'synthesize-3');
    assert.equal(queued.at(-1).outputTargets.length, 2);
    terminal('synthesize-3');
    assert.equal(queued.at(-1).substage, 'verify');
    assert.equal(queued.at(-1).outputTargets.length, 3);
    const finished = terminal('verify');
    assert.equal(finished.complete, true);
    assert.equal(project.stages.research.data.researchPipeline.status, 'completed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('research plan validation enforces adaptive bounds and distinct usable angles', () => {
  assert.equal(normalizedPlan(validPlan(3, 1), { minAngles: 3, maxAngles: 10, maxSynthesisPasses: 3 }).angles.length, 3);
  assert.throws(() => normalizedPlan(validPlan(2, 1)), /3-10 angles/);
  assert.throws(() => normalizedPlan(validPlan(4, 3), { maxSynthesisPasses: 2 }), /1-2 synthesis passes/);
});

test('JobManager permits parallel research angles but protects other stage work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-research-jobs-'));
  try {
    const store = {
      createRun: ({ id, projectKey, stageId, substage }) => ({ id, projectKey, stageId, substage, status: 'queued' }),
      patchStage: () => null,
    };
    const jobs = new JobManager({ store, logsDir: root, maxConcurrent: 0 });
    const project = { projectKey: 'demo__video' };
    const commandSpec = { command: 'true', args: [], expectedOutputs: [] };
    jobs.enqueue({ project, projectPath: root, stageId: 'research', substage: 'angle-01', adapter: 'codex', inputHash: 'a', commandSpec });
    jobs.enqueue({ project, projectPath: root, stageId: 'research', substage: 'angle-02', adapter: 'codex', inputHash: 'b', commandSpec });
    assert.throws(() => jobs.enqueue({ project, projectPath: root, stageId: 'research', substage: 'synthesize-1', adapter: 'codex', inputHash: 'c', commandSpec }), /already running research/);
    clearInterval(jobs.pollTimer);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
