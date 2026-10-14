'use strict';

// The controller is deliberately transport-agnostic: the browser, REST clients and
// MCP all enter through the same methods, while server.js supplies the filesystem and
// worker-specific operations.
class AutomationController {
  constructor({ store, stages, getProject, queueStage, startResearch, validateStage, approveStage, selectIdea, selectScript, startPublish, emit }) {
    Object.assign(this, { store, stages, getProject, queueStage, startResearch, validateStage, approveStage, selectIdea, selectScript, startPublish, emit });
  }

  event(projectKey, workflowId, origin, type, payload = {}) {
    const event = this.store.recordWorkflowEvent({ projectKey, workflowId, origin, type, payload });
    this.emit('workflow_event', { event });
    return event;
  }

  start({ projectKey, mode = 'global', origin = 'gui', topic = null, proactive = false, startStage = null }) {
    const project = this.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const current = this.store.latestWorkflow(projectKey);
    if (current?.status === 'running') throw Object.assign(new Error('Automation is already running for this workspace'), { statusCode: 409 });
    if (mode === 'global' && (!startStage || startStage === 'idea') && !proactive && !String(topic || '').trim()) {
      throw Object.assign(new Error('Provide a topic or choose proactive mode before starting global automation'), { statusCode: 400 });
    }
    const workflow = this.store.createWorkflow({ projectKey, mode, origin, topic: topic || null, proactive });
    if (mode === 'global') {
      this.store.updateProject(projectKey, { settings: { autopilot: true } });
      for (const stage of this.stages.filter((item) => item.id !== 'publish')) this.store.patchStage(projectKey, stage.id, { autoMode: true });
    }
    this.event(projectKey, workflow.id, origin, 'workflow_started', { mode, topic: topic || null, proactive, startStage });
    this.schedule(projectKey, workflow.id, { startStage });
    return this.store.getWorkflow(projectKey, workflow.id);
  }

  pause(projectKey, workflowId, reason, origin = 'system') {
    const workflow = this.store.patchWorkflow(projectKey, workflowId, { status: 'paused', pauseReason: reason });
    this.event(projectKey, workflowId, origin, 'workflow_paused', { reason });
    return workflow;
  }

  resume(projectKey, workflowId, origin = 'gui') {
    const workflow = this.store.patchWorkflow(projectKey, workflowId, { status: 'running', pauseReason: null });
    if (!workflow) throw Object.assign(new Error('Workflow not found'), { statusCode: 404 });
    this.event(projectKey, workflowId, origin, 'workflow_resumed');
    this.schedule(projectKey, workflowId);
    return workflow;
  }

  cancel(projectKey, workflowId, origin = 'gui') {
    const workflow = this.store.patchWorkflow(projectKey, workflowId, { status: 'cancelled', pauseReason: 'Cancelled' });
    if (workflow) this.event(projectKey, workflowId, origin, 'workflow_cancelled');
    return workflow;
  }

  activeFor(projectKey) {
    const workflow = this.store.latestWorkflow(projectKey);
    return workflow?.status === 'running' ? workflow : null;
  }

  schedule(projectKey, workflowId, { startStage = null } = {}) {
    const workflow = this.store.getWorkflow(projectKey, workflowId);
    if (!workflow || workflow.status !== 'running') return;
    const project = this.getProject(projectKey);
    const candidates = this.stages.filter((stage) => {
      if (startStage && stage.id !== startStage) return false;
      if (stage.id === 'publish') return workflow.mode === 'global';
      return workflow.mode === 'global' || project.stages[stage.id]?.autoMode;
    });
    let scheduled = false;
    for (const stage of candidates) {
      const state = project.stages[stage.id];
      if (!state || ['approved', 'queued', 'running', 'blocked'].includes(state.status)) continue;
      if (!stage.requires.every((required) => project.stages[required]?.status === 'approved')) continue;
      try {
        if (stage.id === 'publish') {
          this.event(projectKey, workflowId, workflow.origin, 'publish_queued', { privacy: 'private' });
          this.startPublish(projectKey, { privacy: 'private', origin: workflow.origin, workflowId });
          scheduled = true;
        } else if (stage.id === 'research' && this.startResearch) {
          const started = this.startResearch({ projectKey, adapter: project.stages.research?.agent || project.settings?.defaultAgent, direction: workflow.topic || '' });
          this.event(projectKey, workflowId, workflow.origin, 'stage_queued', { stageId: stage.id, substage: 'plan', runId: started.run.id, pipelineId: started.pipeline.id });
          scheduled = true;
        } else {
          const run = this.queueStage({ projectKey, stageId: stage.id, substage: stage.substages[0], topic: workflow.topic, proactive: workflow.proactive });
          this.event(projectKey, workflowId, workflow.origin, 'stage_queued', { stageId: stage.id, substage: stage.substages[0], runId: run.id });
          scheduled = true;
        }
      } catch (error) {
        this.pause(projectKey, workflowId, error.message);
      }
    }
    if (!scheduled && workflow.mode === 'manual') {
      const waiting = this.stages.find((stage) => stage.id !== 'publish' && project.stages[stage.id]?.status === 'ready'
        && !project.stages[stage.id]?.autoMode && stage.requires.every((required) => project.stages[required]?.status === 'approved'));
      if (waiting) {
        this.store.patchWorkflow(projectKey, workflowId, { status: 'waiting', pauseReason: `Waiting for manual ${waiting.name || waiting.id}` });
        this.event(projectKey, workflowId, workflow.origin, 'workflow_waiting', { stageId: waiting.id });
      }
    }
  }

  onJob(payload) {
    if (payload.type === 'output') return;
    const workflow = this.activeFor(payload.projectKey);
    if (!workflow) return;
    const stage = this.stages.find((item) => item.id === payload.stageId);
    if (!stage) return;
    if (['queued', 'running'].includes(payload.status)) {
      this.event(payload.projectKey, workflow.id, workflow.origin, 'run_updated', { runId: payload.id, stageId: payload.stageId, substage: payload.substage, status: payload.status });
      return;
    }
    if (['failed', 'cancelled', 'interrupted'].includes(payload.status)) {
      const key = `${payload.stageId}/${payload.substage}`;
      const attempts = Number(workflow.retries[key] || 0);
      if (payload.status === 'failed' && !payload.noRetry && attempts < 1) {
        const retries = { ...workflow.retries, [key]: attempts + 1 };
        this.store.patchWorkflow(payload.projectKey, workflow.id, { retries });
        this.event(payload.projectKey, workflow.id, workflow.origin, 'stage_retrying', { stageId: payload.stageId, substage: payload.substage, attempt: attempts + 1, error: payload.error });
        setImmediate(() => {
          try { this.queueStage({ projectKey: payload.projectKey, stageId: payload.stageId, substage: payload.substage }); }
          catch (error) { this.pause(payload.projectKey, workflow.id, error.message); }
        });
      } else this.pause(payload.projectKey, workflow.id, `${payload.stageId}/${payload.substage}: ${payload.error || payload.status}`);
      return;
    }
    if (payload.status !== 'needs_review') return;
    const index = stage.substages.indexOf(payload.substage);
    if (index >= 0 && index < stage.substages.length - 1) {
      const next = stage.substages[index + 1];
      try {
        const run = this.queueStage({ projectKey: payload.projectKey, stageId: stage.id, substage: next });
        this.event(payload.projectKey, workflow.id, workflow.origin, 'substage_queued', { stageId: stage.id, substage: next, runId: run.id });
      } catch (error) { this.pause(payload.projectKey, workflow.id, error.message); }
      return;
    }
    try {
      if (stage.id === 'publish') {
        this.store.patchWorkflow(payload.projectKey, workflow.id, { status: 'completed', pauseReason: null });
        this.event(payload.projectKey, workflow.id, workflow.origin, 'workflow_completed', { publication: true });
        return;
      }
      if (stage.id === 'idea' && !this.selectIdea(payload.projectKey)) throw new Error('No parseable idea was produced');
      if (stage.id === 'script') this.selectScript(payload.projectKey);
      const problems = this.validateStage(payload.projectKey, stage.id);
      if (problems.length) throw new Error(problems.join('; '));
      this.approveStage(payload.projectKey, stage.id, 'Approved by automation after validation');
      this.event(payload.projectKey, workflow.id, workflow.origin, 'stage_approved', { stageId: stage.id });
      setImmediate(() => this.schedule(payload.projectKey, workflow.id));
    } catch (error) { this.pause(payload.projectKey, workflow.id, `${stage.id}: ${error.message}`); }
  }
}

module.exports = { AutomationController };
