'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutomationController } = require('../lib/automation');

test('automation retries a failed substage once and then pauses', () => {
  const events = [];
  let workflow = { id: 'workflow-1', projectKey: 'demo__one', mode: 'global', origin: 'api', status: 'running', retries: {}, pauseReason: null };
  const project = { projectKey: 'demo__one', stages: { idea: { status: 'ready', autoMode: true } } };
  const store = {
    latestWorkflow: () => workflow,
    getWorkflow: () => workflow,
    createWorkflow: () => workflow,
    updateProject: () => project,
    patchStage: () => null,
    patchWorkflow: (_key, _id, patch) => { workflow = { ...workflow, ...patch }; return workflow; },
    recordWorkflowEvent: (event) => { const result = { id: events.length + 1, ...event }; events.push(result); return result; },
  };
  const queued = [];
  const controller = new AutomationController({
    store, stages: [{ id: 'idea', substages: ['generate'], requires: [] }], getProject: () => project,
    queueStage: (input) => { queued.push(input); return { id: `run-${queued.length}` }; }, validateStage: () => [],
    approveStage: () => project, selectIdea: () => true, selectScript: () => true, startPublish: () => ({}), emit: () => {},
  });
  controller.onJob({ projectKey: project.projectKey, stageId: 'idea', substage: 'generate', status: 'failed', id: 'run-a', error: 'network' });
  assert.equal(workflow.retries['idea/generate'], 1);
  assert(events.some((event) => event.type === 'stage_retrying'));
  controller.onJob({ projectKey: project.projectKey, stageId: 'idea', substage: 'generate', status: 'failed', id: 'run-b', error: 'network' });
  assert.equal(workflow.status, 'paused');
  assert.match(workflow.pauseReason, /idea\/generate/);
});
