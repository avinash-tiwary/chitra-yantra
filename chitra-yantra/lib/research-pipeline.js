'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TERMINAL = new Set(['needs_review', 'failed', 'cancelled', 'interrupted']);

function safeReadJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    try { return JSON.parse(text); }
    catch {
      const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      return fenced ? JSON.parse(fenced[1]) : null;
    }
  } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function nextVersion(projectPath) {
  const directory = path.join(projectPath, '01_research');
  if (!fs.existsSync(directory)) return 1;
  return fs.readdirSync(directory).reduce((highest, name) => {
    const version = Number(name.match(/^research_pipeline_v(\d+)\.json$/)?.[1] || 0);
    return Math.max(highest, version);
  }, 0) + 1;
}

function normalizedPlan(raw, limits = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Research plan must be a JSON object');
  const minAngles = Math.max(3, Math.min(10, Number(limits.minAngles) || 3));
  const maxAngles = Math.max(minAngles, Math.min(10, Number(limits.maxAngles) || 10));
  const maxSynthesisPasses = Math.max(1, Math.min(3, Number(limits.maxSynthesisPasses) || 3));
  if (!Array.isArray(raw.angles) || raw.angles.length < minAngles || raw.angles.length > maxAngles) {
    throw new Error(`Research plan must contain ${minAngles}-${maxAngles} angles`);
  }
  const synthesisPasses = Number(raw.synthesisPasses);
  if (!Number.isInteger(synthesisPasses) || synthesisPasses < 1 || synthesisPasses > maxSynthesisPasses) {
    throw new Error(`Research plan must choose 1-${maxSynthesisPasses} synthesis passes`);
  }
  const seen = new Set();
  const angles = raw.angles.map((angle, index) => {
    if (!angle || typeof angle !== 'object' || Array.isArray(angle)) throw new Error(`Research angle ${index + 1} must be an object`);
    const id = `angle-${String(index + 1).padStart(2, '0')}`;
    const title = String(angle.title || '').trim();
    const objective = String(angle.objective || '').trim();
    const questions = Array.isArray(angle.questions) ? angle.questions.map((item) => String(item).trim()).filter(Boolean) : [];
    if (!title || !objective || !questions.length) throw new Error(`Research angle ${index + 1} requires title, objective, and questions`);
    const fingerprint = `${title.toLowerCase()}\n${objective.toLowerCase()}`;
    if (seen.has(fingerprint)) throw new Error(`Research angle ${index + 1} duplicates an earlier angle`);
    seen.add(fingerprint);
    return {
      id, title, objective, questions,
      sourceStrategy: Array.isArray(angle.sourceStrategy) ? angle.sourceStrategy.map(String).filter(Boolean) : [],
      boundaries: Array.isArray(angle.boundaries) ? angle.boundaries.map(String).filter(Boolean) : [],
      priority: ['high', 'medium', 'low'].includes(angle.priority) ? angle.priority : 'medium',
      risk: ['high', 'medium', 'low'].includes(angle.risk) ? angle.risk : 'medium',
    };
  });
  return {
    schemaVersion: 1,
    topic: String(raw.topic || '').trim(),
    pitch: String(raw.pitch || '').trim(),
    rationale: String(raw.rationale || '').trim(),
    synthesisPasses,
    angles,
  };
}

class ResearchPipelineController {
  constructor({ store, getProject, projectPathForKey, queueStage, cancelRuns = () => {}, emit = () => {} }) {
    Object.assign(this, { store, getProject, projectPathForKey, queueStage, cancelRuns, emit });
  }

  manifestPath(projectPath, version) {
    return path.join(projectPath, '01_research', `research_pipeline_v${version}.json`);
  }

  persist(projectKey, state) {
    const next = { ...state, updatedAt: new Date().toISOString() };
    this.store.patchStage(projectKey, 'research', { data: { researchPipeline: next } });
    writeJsonAtomic(this.manifestPath(this.projectPathForKey(projectKey), next.version), next);
    this.emit('research_pipeline', { projectKey, pipeline: next });
    return next;
  }

  start({ projectKey, adapter, direction = '' }) {
    const project = this.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const current = project.stages?.research?.data?.researchPipeline;
    if (current && ['planning', 'researching', 'synthesizing', 'verifying'].includes(current.status)) {
      throw Object.assign(new Error('Research pipeline is already running'), { statusCode: 409 });
    }
    const projectPath = this.projectPathForKey(projectKey);
    const version = nextVersion(projectPath);
    const limits = {
      minAngles: 3,
      maxAngles: Number(project.settings?.researchMaxAngles || 10),
      maxSynthesisPasses: Number(project.settings?.researchMaxSynthesisPasses || 3),
    };
    let state = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      version,
      status: 'planning',
      adapter: (adapter || project.settings?.defaultAgent) === 'python' ? 'codex' : (adapter || project.settings?.defaultAgent || 'codex'),
      direction: String(direction || '').trim().slice(0, 20_000),
      limits,
      planPath: `01_research/plans/research_plan_v${version}.json`,
      angleCount: null,
      synthesisPasses: null,
      tasks: {},
      retries: {},
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    state = this.persist(projectKey, state);
    const task = {
      substage: 'plan',
      outputs: [state.planPath],
      researchTask: { pipelineId: state.id, version, kind: 'plan', ...limits, direction: state.direction },
    };
    try { return this.enqueue(projectKey, state, task); }
    catch (error) {
      this.fail(projectKey, state, error.message);
      throw error;
    }
  }

  enqueue(projectKey, state, task) {
    const run = this.queueStage({
      projectKey,
      stageId: 'research',
      substage: task.substage,
      adapter: state.adapter,
      outputTargets: task.outputs,
      iterationNote: state.direction,
      researchTask: task.researchTask,
    });
    const tasks = { ...state.tasks, [task.substage]: { ...task, runId: run.id, status: 'queued' } };
    const next = this.persist(projectKey, { ...state, tasks });
    return { pipeline: next, run };
  }

  fail(projectKey, state, message) {
    const next = this.persist(projectKey, { ...state, status: 'failed', error: String(message || 'Research pipeline failed') });
    this.cancelRuns(projectKey);
    this.store.patchStage(projectKey, 'research', { status: 'failed' });
    return { handled: false, payload: { status: 'failed', error: next.error, noRetry: true } };
  }

  retry(projectKey, state, payload) {
    const task = state.tasks?.[payload.substage];
    const attempts = Number(state.retries?.[payload.substage] || 0);
    if (!task || attempts >= 1 || payload.status !== 'failed') return this.fail(projectKey, state, `${payload.substage}: ${payload.error || payload.status}`);
    const retries = { ...state.retries, [payload.substage]: attempts + 1 };
    const next = this.persist(projectKey, { ...state, retries, error: null });
    this.enqueue(projectKey, next, task);
    return { handled: true };
  }

  taskCompleted(projectKey, state, substage) {
    const task = state.tasks?.[substage];
    if (!task) return state;
    return this.persist(projectKey, { ...state, tasks: { ...state.tasks, [substage]: { ...task, status: 'completed' } } });
  }

  onJob(payload) {
    if (payload.stageId !== 'research' || !TERMINAL.has(payload.status)) return null;
    const project = this.getProject(payload.projectKey);
    const state = project?.stages?.research?.data?.researchPipeline;
    if (!state || !state.tasks?.[payload.substage]) return null;
    // Ignore a late terminal event from a cancelled/retried run that happens to
    // share the same substage name with the current pipeline task.
    if (state.tasks[payload.substage].runId !== payload.id) return { handled: true, pipeline: state };
    if (state.status === 'failed') return { handled: true, pipeline: state };
    if (payload.status !== 'needs_review') return this.retry(payload.projectKey, state, payload);

    let next = this.taskCompleted(payload.projectKey, state, payload.substage);
    try {
      if (payload.substage === 'plan') return this.finishPlan(payload.projectKey, next);
      if (/^angle-[0-9]{2}$/.test(payload.substage)) return this.finishAngle(payload.projectKey, next);
      if (/^synthesize-[1-3]$/.test(payload.substage)) return this.finishSynthesis(payload.projectKey, next, payload.substage);
      if (payload.substage === 'verify') {
        next = this.persist(payload.projectKey, { ...next, status: 'completed', completedAt: new Date().toISOString(), error: null });
        return { handled: false, complete: true, pipeline: next };
      }
    } catch (error) {
      return this.fail(payload.projectKey, next, error.message);
    }
    return null;
  }

  finishPlan(projectKey, state) {
    const projectPath = this.projectPathForKey(projectKey);
    const plan = normalizedPlan(safeReadJson(path.join(projectPath, state.planPath)), state.limits);
    writeJsonAtomic(path.join(projectPath, state.planPath), plan);
    let next = this.persist(projectKey, {
      ...state,
      status: 'researching',
      angleCount: plan.angles.length,
      synthesisPasses: plan.synthesisPasses,
      plan,
    });
    const runs = [];
    for (const angle of plan.angles) {
      const task = {
        substage: angle.id,
        outputs: [`01_research/passes/${angle.id}_v${state.version}.md`],
        researchTask: { pipelineId: state.id, version: state.version, kind: 'angle', planPath: state.planPath, angle },
      };
      const queued = this.enqueue(projectKey, next, task);
      next = queued.pipeline;
      runs.push(queued.run);
    }
    return { handled: true, pipeline: next, runs };
  }

  finishAngle(projectKey, state) {
    const angles = Object.values(state.tasks).filter((task) => /^angle-[0-9]{2}$/.test(task.substage));
    if (!angles.length || angles.some((task) => task.status !== 'completed')) return { handled: true, pipeline: state };
    if (state.tasks['synthesize-1']) return { handled: true, pipeline: state };
    const next = this.persist(projectKey, { ...state, status: 'synthesizing' });
    const queued = this.enqueue(projectKey, next, this.synthesisTask(next, 1));
    return { handled: true, pipeline: queued.pipeline, runs: [queued.run] };
  }

  synthesisTask(state, pass) {
    const final = pass === state.synthesisPasses;
    const outputs = final
      ? [`01_research/dossiers/evidence_v${state.version}.md`, `01_research/synthesis/coverage_v${state.version}.json`]
      : [`01_research/synthesis/synthesis_v${state.version}_pass_${pass}.md`];
    return {
      substage: `synthesize-${pass}`,
      outputs,
      researchTask: {
        pipelineId: state.id,
        version: state.version,
        kind: 'synthesis',
        pass,
        passCount: state.synthesisPasses,
        final,
        planPath: state.planPath,
        angleOutputs: Object.values(state.tasks).filter((task) => /^angle-/.test(task.substage)).flatMap((task) => task.outputs),
        previousOutput: pass > 1 ? `01_research/synthesis/synthesis_v${state.version}_pass_${pass - 1}.md` : null,
      },
    };
  }

  finishSynthesis(projectKey, state, substage) {
    const pass = Number(substage.split('-')[1]);
    if (pass < state.synthesisPasses) {
      const queued = this.enqueue(projectKey, state, this.synthesisTask(state, pass + 1));
      return { handled: true, pipeline: queued.pipeline, runs: [queued.run] };
    }
    if (state.tasks.verify) return { handled: true, pipeline: state };
    const next = this.persist(projectKey, { ...state, status: 'verifying' });
    const task = {
      substage: 'verify',
      outputs: [
        `01_research/verification/verification_v${state.version}.md`,
        `01_research/claims/claim_ledger_v${state.version}.json`,
        `01_research/dossiers/production_v${state.version}.md`,
      ],
      researchTask: {
        pipelineId: state.id,
        version: state.version,
        kind: 'verify',
        planPath: state.planPath,
        dossierPath: `01_research/dossiers/evidence_v${state.version}.md`,
        coveragePath: `01_research/synthesis/coverage_v${state.version}.json`,
        angleOutputs: Object.values(state.tasks).filter((task) => /^angle-/.test(task.substage)).flatMap((task) => task.outputs),
      },
    };
    const queued = this.enqueue(projectKey, next, task);
    return { handled: true, pipeline: queued.pipeline, runs: [queued.run] };
  }
}

module.exports = { ResearchPipelineController, normalizedPlan, nextVersion };
