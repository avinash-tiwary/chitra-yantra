'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { JobManager } = require('../lib/jobs');

test('stage_runs stores and returns command_line and cwd', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-run-cmd-'));
  try {
    const database = path.join(directory, 'test.db');
    const store = new Store(database, null);
    store.ensureProject({ projectKey: 'example-channel__terminal-test', channelId: 'example-channel', slug: 'terminal-test', title: 'Terminal Test' });
    const run = store.createRun({
      id: 'test-run-cmd-1',
      projectKey: 'example-channel__terminal-test',
      stageId: 'idea',
      substage: 'generate',
      adapter: 'antigravity',
      inputHash: 'hash123',
      logPath: path.join(directory, 'test.log'),
      commandLine: 'agy --print "generate ideas" --mode accept-edits',
      cwd: '/path/to/project',
    });
    assert.equal(run.commandLine, 'agy --print "generate ideas" --mode accept-edits');
    assert.equal(run.cwd, '/path/to/project');

    const fetched = store.getRun('test-run-cmd-1');
    assert.equal(fetched.commandLine, 'agy --print "generate ideas" --mode accept-edits');
    assert.equal(fetched.cwd, '/path/to/project');

    const list = store.listRuns('example-channel__terminal-test');
    assert.equal(list.length, 1);
    assert.equal(list[0].commandLine, 'agy --print "generate ideas" --mode accept-edits');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JobManager logs shell command header banner and finish banner', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-job-banner-'));
  try {
    const database = path.join(directory, 'test.db');
    const logsDir = path.join(directory, 'logs');
    const store = new Store(database, null);
    const project = store.ensureProject({ projectKey: 'example-channel__job-test', channelId: 'example-channel', slug: 'job-test', title: 'Job Test' });

    let emittedOutput = '';
    const jobs = new JobManager({
      store,
      logsDir,
      onEvent(type, payload) {
        if (type === 'output') emittedOutput += payload.text;
      }
    });

    const expectedFile = '00_project/ideas.md';
    const projectPath = directory;
    fs.mkdirSync(path.join(projectPath, '00_project'), { recursive: true });

    const commandSpec = {
      command: process.execPath,
      args: ['-e', `fs.writeFileSync('${path.join(projectPath, expectedFile)}', '# Ideas\\n\\n1. Idea A'); console.log('Generated mock ideas');`],
      cwd: projectPath,
      expectedOutputs: [expectedFile]
    };

    const runRecord = jobs.enqueue({
      project,
      stageId: 'idea',
      substage: 'generate',
      adapter: 'custom-node',
      inputHash: 'hash-abc',
      commandSpec,
      projectPath,
    });

    assert.ok(runRecord.commandLine.includes(process.execPath));
    assert.equal(runRecord.cwd, projectPath);

    // Wait for the job process to complete
    await new Promise((resolve) => {
      const check = setInterval(() => {
        const run = store.getRun(runRecord.id);
        if (run && ['needs_review', 'failed', 'cancelled'].includes(run.status)) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const finalRun = store.getRun(runRecord.id);
    assert.equal(finalRun.status, 'needs_review');
    assert.equal(finalRun.exitCode, 0);

    const logContent = fs.readFileSync(finalRun.logPath, 'utf8');
    assert.ok(logContent.includes(`$ cd ${projectPath}`));
    assert.ok(logContent.includes(process.execPath));
    assert.ok(logContent.includes('Generated mock ideas'));
    assert.ok(logContent.includes('[Process completed successfully (exit code 0)]'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JobManager reattaches a detached running command after a server restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-job-recover-'));
  try {
    const database = path.join(directory, 'test.db');
    const logsDir = path.join(directory, 'logs');
    const output = path.join(directory, '00_project', 'ideas.md');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const store = new Store(database, null);
    const project = store.ensureProject({ projectKey: 'example-channel__recover-test', channelId: 'example-channel', slug: 'recover-test', title: 'Recover Test' });
    const run = store.createRun({
      id: 'recover-run-1', projectKey: project.projectKey, stageId: 'idea', substage: 'generate', adapter: 'custom-node', inputHash: 'recover',
      logPath: path.join(logsDir, 'recover-run-1.log'), cwd: directory, expectedOutputs: ['00_project/ideas.md'],
    });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(run.logPath, '[started before restart]\n');
    const child = require('node:child_process').spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(output)}, '# Recovered'), 150)`], {
      cwd: directory, detached: process.platform !== 'win32', stdio: 'ignore',
    });
    child.unref();
    store.startRun(run.id, child.pid);
    store.patchStage(project.projectKey, 'idea', { status: 'running' });

    const jobs = new JobManager({ store, logsDir, projectPathForKey: () => directory });
    jobs.recoverActiveRuns();
    assert.equal(jobs.active.has(run.id), true);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Recovered command did not settle')), 5_000);
      const check = setInterval(() => {
        const current = store.getRun(run.id);
        if (current && ['needs_review', 'failed', 'interrupted'].includes(current.status)) {
          clearTimeout(timeout); clearInterval(check); resolve();
        }
      }, 25);
    });
    assert.equal(store.getRun(run.id).status, 'needs_review');
    assert.equal(store.getProject(project.projectKey).stages.idea.status, 'needs_review');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
