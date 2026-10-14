'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');

test('SQLite state persists projects, runs, revisions, and approval gates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-store-'));
  try {
    const database = path.join(directory, 'test.db');
    let store = new Store(database, null);
    const project = store.ensureProject({ projectKey: 'example-channel__test-video', channelId: 'example-channel', slug: 'test-video', title: 'Test video' });
    assert.equal(project.stages.idea.status, 'ready');
    assert.equal(project.stages.research.status, 'blocked');
    store.recordArtifact({ projectKey: project.projectKey, stageId: 'idea', relativePath: '00_project/brief.md', content: 'First', mimeType: 'text/markdown' });
    const second = store.recordArtifact({ projectKey: project.projectKey, stageId: 'idea', relativePath: '00_project/brief.md', content: 'Second', mimeType: 'text/markdown' });
    assert.equal(second.revision, 2);
    const revisions = store.listArtifactRevisions(project.projectKey, '00_project/brief.md');
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].restorable, true);
    assert.equal(store.getArtifactRevision(project.projectKey, revisions[1].id).content.toString(), 'First');
    store.approve({ projectKey: project.projectKey, stageId: 'idea', decision: 'approved' });
    assert.equal(store.getProject(project.projectKey).stages.research.status, 'ready');
    const run = store.createRun({ id: 'run-1', projectKey: project.projectKey, stageId: 'research', substage: 'research', adapter: 'python', inputHash: 'abc', logPath: '/tmp/run.log' });
    assert.equal(run.attempt, 1);
    store.startRun(run.id, 123); store.finishRun(run.id, { status: 'needs_review', exitCode: 0 });
    store = new Store(database, null);
    assert.equal(store.listArtifacts(project.projectKey)[0].revision, 2);
    assert.equal(store.getRun(run.id).status, 'needs_review');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('opening the store preserves active work for JobManager reconciliation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-recovery-'));
  try {
    const database = path.join(directory, 'test.db');
    let store = new Store(database, null);
    store.ensureProject({ projectKey: 'archive-channel__recovery', channelId: 'archive-channel', slug: 'recovery', title: 'Recovery' });
    store.createRun({ id: 'run-live', projectKey: 'archive-channel__recovery', stageId: 'idea', substage: 'generate', adapter: 'codex', inputHash: 'x', logPath: '/tmp/live.log' });
    store.startRun('run-live', 99999); store.patchStage('archive-channel__recovery', 'idea', { status: 'running' });
    store = new Store(database, null);
    assert.equal(store.getRun('run-live').status, 'running');
    assert.equal(store.getProject('archive-channel__recovery').stages.idea.status, 'running');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('moving a workspace keeps its stage history under the new channel key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-move-'));
  try {
    const store = new Store(path.join(directory, 'test.db'), null);
    const project = store.ensureProject({ projectKey: 'example-channel__video-2026-09-14-1730', channelId: 'example-channel', slug: 'video-2026-09-14-1730', title: 'Untitled video' });
    store.recordArtifact({ projectKey: project.projectKey, stageId: 'idea', relativePath: '00_project/project_brief.md', content: 'Ready to plan', mimeType: 'text/markdown' });
    store.createRun({ id: 'move-run', projectKey: project.projectKey, stageId: 'idea', substage: 'generate', adapter: 'codex', inputHash: 'abc', logPath: '/tmp/move.log' });
    const moved = store.moveProjectKey(project.projectKey, { newProjectKey: 'archive-channel__video-2026-09-14-1730', channelId: 'archive-channel' });
    assert.equal(moved.projectKey, 'archive-channel__video-2026-09-14-1730');
    assert.equal(moved.channelId, 'archive-channel');
    assert.equal(store.getProject(project.projectKey), null);
    assert.equal(store.listArtifacts(moved.projectKey).length, 1);
    assert.equal(store.getRun('move-run').projectKey, moved.projectKey);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('deleting a workspace removes project, cascades child tables, and deletes logs while leaving others intact', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-delete-'));
  try {
    const store = new Store(path.join(directory, 'test.db'), null);
    const p1 = store.ensureProject({ projectKey: 'example-channel__to-delete', channelId: 'example-channel', slug: 'to-delete', title: 'To Delete' });
    const p2 = store.ensureProject({ projectKey: 'example-channel__keep-me', channelId: 'example-channel', slug: 'keep-me', title: 'Keep Me' });

    const logFile = path.join(directory, 'run.log');
    fs.writeFileSync(logFile, 'run output');
    store.createRun({ id: 'run-delete', projectKey: p1.projectKey, stageId: 'idea', substage: 'generate', adapter: 'codex', inputHash: '123', logPath: logFile });
    store.recordArtifact({ projectKey: p1.projectKey, stageId: 'idea', relativePath: '00_project/idea_v1.md', content: '# Idea', mimeType: 'text/markdown' });

    assert.equal(store.deleteProject(p1.projectKey), true);
    assert.equal(store.getProject(p1.projectKey), null);
    assert.equal(store.listArtifacts(p1.projectKey).length, 0);
    assert.equal(store.listRuns(p1.projectKey).length, 0);
    assert.equal(fs.existsSync(logFile), false);

    // Verify p2 is completely untouched
    assert.notEqual(store.getProject(p2.projectKey), null);
    assert.equal(store.getProject(p2.projectKey).title, 'Keep Me');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('script versions preserve review threads and one selected master', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-script-workflow-'));
  try {
    const store = new Store(path.join(directory, 'test.db'), null);
    const project = store.ensureProject({ projectKey: 'example-channel__script-workflow', channelId: 'example-channel', slug: 'script-workflow', title: 'Script workflow' });
    const first = store.upsertScriptVersion({ projectKey: project.projectKey, relativePath: '02_script/draft_v1_hindi.md', language: 'hindi' });
    const second = store.upsertScriptVersion({ projectKey: project.projectKey, relativePath: '02_script/draft_v2_hindi.md', parentId: first.id, language: 'hindi' });
    const comment = store.addScriptComment({ projectKey: project.projectKey, scriptVersionId: first.id, scope: 'text', quoteText: 'A claim', body: 'Cite this more carefully.' });
    assert.equal(store.listScriptComments(project.projectKey, first.id).length, 1);
    assert.equal(store.resolveScriptComment(project.projectKey, comment.id).status, 'resolved');
    store.selectMasterScript(project.projectKey, first.id, 'First choice');
    store.selectMasterScript(project.projectKey, second.id, 'Revised choice');
    const versions = store.listScriptVersions(project.projectKey);
    assert.equal(versions.filter((version) => version.isMaster).length, 1);
    assert.equal(versions.find((version) => version.isMaster).id, second.id);
    assert.equal(versions.find((version) => version.id === first.id).isMaster, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
