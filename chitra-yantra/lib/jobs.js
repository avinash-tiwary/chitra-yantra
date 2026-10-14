'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { missingRequiredOutputs } = require('./adapters');

function formatShellCommand(command, args = []) {
  return [command, ...args].map((arg) => {
    if (typeof arg !== 'string') return String(arg);
    if (/^[a-zA-Z0-9_\-\.\/=]+$/.test(arg)) return arg;
    return JSON.stringify(arg);
  }).join(' ');
}

function workerEnvironment(parentEnvironment = process.env) {
  const childEnvironment = Object.fromEntries([
    'PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME', 'XDG_CONFIG_HOME',
  ].filter((key) => parentEnvironment[key] !== undefined).map((key) => [key, parentEnvironment[key]]));
  // GUI-launched Node processes on macOS often omit Homebrew's bin directory.
  // Keep the inherited PATH first, then add only standard executable locations.
  const fallbackPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const pathEntries = String(childEnvironment.PATH || '').split(path.delimiter).filter(Boolean);
  childEnvironment.PATH = [...new Set([...pathEntries, ...fallbackPaths])].join(path.delimiter);
  childEnvironment.PYTHONUNBUFFERED = '1';
  return childEnvironment;
}

class JobManager {
  constructor({ store, logsDir, onEvent, maxConcurrent = 2, projectPathForKey = null }) {
    this.store = store;
    this.logsDir = logsDir;
    this.onEvent = onEvent;
    this.maxConcurrent = maxConcurrent;
    this.projectPathForKey = projectPathForKey;
    this.queue = [];
    this.active = new Map();
    fs.mkdirSync(logsDir, { recursive: true });
    this.pollTimer = setInterval(() => this.pollActiveJobs(), 750);
    this.pollTimer.unref();
  }

  enqueue({ project, stageId, substage, adapter, inputHash, commandSpec, projectPath, resource = null }) {
    const siblingJobs = [...this.active.values(), ...this.queue].filter((job) => job.project.projectKey === project.projectKey && job.stageId === stageId);
    const parallelResearchAngle = stageId === 'research' && /^angle-[0-9]{2}$/.test(substage);
    if (siblingJobs.some((job) => job.substage === substage) || (!parallelResearchAngle && siblingJobs.length)) {
      throw Object.assign(new Error(`This workspace is already running ${stageId}`), { statusCode: 409 });
    }
    const id = crypto.randomUUID();
    const logPath = path.join(this.logsDir, `${id}.log`);
    const commandLine = formatShellCommand(commandSpec.command, commandSpec.args || []);
    const cwd = commandSpec.cwd || projectPath;
    const record = this.store.createRun({ id, projectKey: project.projectKey, stageId, substage, adapter, inputHash, logPath, commandLine, cwd, expectedOutputs: commandSpec.expectedOutputs || [] });
    const job = { id, project, stageId, substage, adapter, commandSpec, commandLine, cwd, projectPath, logPath, resource, cancelled: false };
    this.queue.push(job);
    this.store.patchStage(project.projectKey, stageId, { status: 'queued' });
    this.emit('job', record);
    this.drain();
    return record;
  }

  drain() {
    // MLX TTS, ACE-Step and DeepFilterNet all draw from the same unified-memory
    // pool on Apple Silicon.  Keep an explicit resource lane so unrelated
    // workflow work may still run, while model-backed audio work is serial.
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const index = this.queue.findIndex((job) => !job.resource || ![...this.active.values()].some((active) => active.resource === job.resource));
      if (index < 0) break;
      this.start(this.queue.splice(index, 1)[0]);
    }
  }

  start(job) {
    const childEnvironment = workerEnvironment();
    const logFd = fs.openSync(job.logPath, 'a', 0o600);
    const startBanner = `[${new Date().toISOString()}] Starting ${job.stageId}/${job.substage} with ${job.adapter}\n$ cd ${job.cwd}\n$ ${job.commandLine}\n\n`;
    fs.writeSync(logFd, startBanner);
    const child = spawn(job.commandSpec.command, job.commandSpec.args, {
      cwd: job.commandSpec.cwd, env: childEnvironment, shell: false,
      // Persist output directly to the durable run log. Pipes are severed when
      // the web server restarts, which used to make CLI commands fail on a
      // browser refresh/reconnect path.
      detached: process.platform !== 'win32', stdio: ['ignore', logFd, logFd],
    });
    job.child = child;
    job.pid = child.pid;
    job.logFd = logFd;
    job.startedAt = Date.now();
    job.logOffset = fs.fstatSync(logFd).size;
    this.active.set(job.id, job);
    const timeoutMs = Number(job.commandSpec.timeoutMs || 0);
    if (timeoutMs > 0) {
      job.timeoutTimer = setTimeout(() => {
        if (job.finished) return;
        job.timedOut = true;
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        } else child.kill('SIGTERM');
        setTimeout(() => {
          if (job.finished) return;
          if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
          else child.kill('SIGKILL');
        }, 5000).unref();
      }, timeoutMs);
      job.timeoutTimer.unref();
    }
    this.store.startRun(job.id, child.pid);
    this.store.patchStage(job.project.projectKey, job.stageId, { status: 'running' });
    this.emit('job', this.store.getRun(job.id));
    this.emit('output', { runId: job.id, projectKey: job.project.projectKey, stageId: job.stageId, substage: job.substage, stream: 'stdout', text: startBanner });

    child.on('error', (error) => {
      const message = error.code === 'ENOENT'
        ? `Cannot start ${job.commandSpec.command}: executable was not found on the worker PATH. Install the CLI or restart Chitra Yantra from a shell where \`${job.commandSpec.command} --version\` succeeds.`
        : error.message;
      this.finish(job, { status: 'failed', exitCode: null, error: message });
    });
    child.on('close', (code, signal) => {
      if (job.finished) return;
      if (job.timedOut) return this.finish(job, { status: 'failed', exitCode: code, error: `Timed out after ${Math.round(Number(job.commandSpec.timeoutMs) / 60_000)} minutes` });
      if (job.cancelled) return this.finish(job, { status: 'cancelled', exitCode: code, error: `Stopped (${signal || 'cancelled'})` });
      if (code !== 0) return this.finish(job, { status: 'failed', exitCode: code, error: `Process exited with code ${code}` });
      const missing = missingRequiredOutputs(job.projectPath, job.stageId, job.substage, job.commandSpec.expectedOutputs);
      if (missing.length) return this.finish(job, { status: 'failed', exitCode: code, error: `Required output missing: ${missing.join(', ')}` });
      this.finish(job, { status: 'needs_review', exitCode: code, error: null });
    });
  }

  finish(job, { status, exitCode, error }) {
    if (job.finished) return;
    job.finished = true;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    this.flushOutput(job);
    const endBanner = exitCode === 0 && !error
      ? `\n\n[Process completed successfully (exit code 0)]\n`
      : `\n\n[Process failed with exit code ${exitCode ?? 'none'}${error ? `: ${error}` : ''}]\n`;
    this.writeLog(job, `${endBanner}[${new Date().toISOString()}] ${status}${error ? `: ${error}` : ''}\n`);
    if (job.logFd !== undefined) {
      try { fs.closeSync(job.logFd); } catch { /* already closed during host shutdown */ }
      job.logFd = undefined;
    }
    this.emit('output', { runId: job.id, projectKey: job.project.projectKey, stageId: job.stageId, substage: job.substage, stream: exitCode === 0 && !error ? 'stdout' : 'stderr', text: endBanner });
    this.store.finishRun(job.id, { status, exitCode, error });
    this.active.delete(job.id);
    const siblingActive = [...this.active.values()].some((item) => item.project.projectKey === job.project.projectKey && item.stageId === job.stageId);
    const siblingQueued = this.queue.some((item) => item.project.projectKey === job.project.projectKey && item.stageId === job.stageId);
    const stageStatus = siblingActive ? 'running' : siblingQueued ? 'queued' : status === 'needs_review' ? 'needs_review' : 'failed';
    this.store.patchStage(job.project.projectKey, job.stageId, { status: stageStatus });
    this.emit('job', this.store.getRun(job.id));
    this.drain();
  }

  writeLog(job, text) {
    try {
      if (job.logFd !== undefined) fs.writeSync(job.logFd, text);
      else fs.appendFileSync(job.logPath, text, { mode: 0o600 });
      job.logOffset = fs.statSync(job.logPath).size;
    } catch { /* a log write must not make a completed command look active */ }
  }

  flushOutput(job) {
    try {
      const size = fs.statSync(job.logPath).size;
      const offset = Number(job.logOffset || 0);
      if (size <= offset) return;
      const length = Math.min(size - offset, 64 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(job.logPath, 'r');
      fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      job.logOffset = offset + length;
      this.emit('output', { runId: job.id, projectKey: job.project.projectKey, stageId: job.stageId, substage: job.substage, stream: 'stdout', text: buffer.toString('utf8') });
    } catch { /* the log may not exist yet while a process is starting */ }
  }

  processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  }

  recoverActiveRuns() {
    if (!this.projectPathForKey) return;
    for (const run of this.store.listActiveRuns()) {
      if (run.status === 'queued') {
        this.store.finishRun(run.id, { status: 'interrupted', error: 'Server restarted before this queued command could begin' });
        this.store.patchStage(run.projectKey, run.stageId, { status: 'failed' });
        this.emit('job', this.store.getRun(run.id));
        continue;
      }
      let projectPath;
      try { projectPath = this.projectPathForKey(run.projectKey); } catch { projectPath = null; }
      if (!projectPath || !this.processIsAlive(run.pid)) {
        this.store.finishRun(run.id, { status: 'interrupted', error: 'Command process was no longer running when the server reconnected' });
        this.store.patchStage(run.projectKey, run.stageId, { status: 'failed' });
        this.emit('job', this.store.getRun(run.id));
        continue;
      }
      const project = this.store.getProject(run.projectKey);
      const job = { id: run.id, project, projectPath, stageId: run.stageId, substage: run.substage, adapter: run.adapter,
        pid: run.pid, logPath: run.logPath, logOffset: 0, recovered: true,
        commandSpec: { expectedOutputs: run.expectedOutputs } };
      this.active.set(job.id, job);
      this.store.patchStage(run.projectKey, run.stageId, { status: 'running' });
      this.emit('job', this.store.getRun(run.id));
      this.flushOutput(job);
    }
  }

  pollActiveJobs() {
    for (const job of [...this.active.values()]) {
      this.flushOutput(job);
      if (!job.recovered || this.processIsAlive(job.pid)) continue;
      const missing = missingRequiredOutputs(job.projectPath, job.stageId, job.substage, job.commandSpec.expectedOutputs);
      this.finish(job, missing.length
        ? { status: 'failed', exitCode: null, error: `Command ended after server reconnect; required output missing: ${missing.join(', ')}` }
        : { status: 'needs_review', exitCode: null, error: null });
    }
  }

  cancel(id) {
    const queuedIndex = this.queue.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      this.store.finishRun(id, { status: 'cancelled', error: 'Cancelled before start' });
      this.store.patchStage(job.project.projectKey, job.stageId, { status: 'ready' });
      this.emit('job', this.store.getRun(id));
      return true;
    }
    const job = this.active.get(id);
    if (!job) return false;
    job.cancelled = true;
    if (process.platform !== 'win32') {
      try { process.kill(-job.child.pid, 'SIGTERM'); } catch { job.child.kill('SIGTERM'); }
    } else job.child.kill('SIGTERM');
    setTimeout(() => {
      if (!job.finished) {
        if (process.platform !== 'win32') { try { process.kill(-job.child.pid, 'SIGKILL'); } catch { job.child.kill('SIGKILL'); } }
        else job.child.kill('SIGKILL');
      }
    }, 5000).unref();
    return true;
  }

  cancelForProject(projectKey, stageId = null) {
    if (!projectKey) return;
    const matches = (job) => job.project?.projectKey === projectKey && (!stageId || job.stageId === stageId);
    const queued = this.queue.filter(matches);
    for (const job of queued) this.cancel(job.id);
    for (const job of [...this.active.values()]) {
      if (matches(job)) this.cancel(job.id);
    }
  }

  emit(type, payload) { if (this.onEvent) this.onEvent(type, payload); }
}

module.exports = { JobManager, workerEnvironment };
