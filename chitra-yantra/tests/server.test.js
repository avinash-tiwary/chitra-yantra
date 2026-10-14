'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const port = 18743;
let server;
let cookie;
let csrf;
const fixtureChannelRoot = path.resolve(appRoot, '..', 'channels', 'test-channel');

test.before(async () => {
  fs.mkdirSync(path.join(fixtureChannelRoot, 'videos', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(fixtureChannelRoot, 'videos', 'fixture', 'README.md'), '# Test fixture\n');
  server = spawn(process.execPath, ['server.js'], { cwd: appRoot, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.stdout.on('data', (chunk) => { if (chunk.toString().includes('http://')) { clearTimeout(timeout); resolve(); } });
    server.on('exit', (code) => reject(new Error(`Server exited ${code}`)));
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0];
  csrf = (await response.json()).csrfToken;
});

test.after(() => {
  if (server && !server.killed) server.kill('SIGTERM');
  fs.rmSync(fixtureChannelRoot, { recursive: true, force: true });
});

test('static responses include a restrictive CSP', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('a workspace URL serves the app shell for client-side routing', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/videos/test-channel__fixture`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /id="project-workspace"/);
  assert.match(text, /id="nav-dashboard"/);
  assert.match(text, /Go to dashboard/);
  assert.match(text, /id="new-project"/);

  const trailingSlash = await fetch(`http://127.0.0.1:${port}/videos/test-channel__fixture/`);
  assert.equal(trailingSlash.status, 200);
  assert.match(await trailingSlash.text(), /id="project-workspace"/);

  const cleanUrl = await fetch(`http://127.0.0.1:${port}/videos/test-channel/fixture`);
  assert.equal(cleanUrl.status, 200);
  assert.match(await cleanUrl.text(), /id="project-workspace"/);

  const cleanWithStage = await fetch(`http://127.0.0.1:${port}/videos/test-channel/fixture?stage=script`);
  assert.equal(cleanWithStage.status, 200);
  assert.match(await cleanWithStage.text(), /id="project-workspace"/);
});

test('health endpoint is monitorable without creating a browser session', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '2.0.0');
});

test('API requires a session and rejects cross-origin calls', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status, 401);
  const evil = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('loopback agent API creates workspaces and exposes durable events without browser cookies', async () => {
  const create = await fetch(`http://127.0.0.1:${port}/api/agent/v1/workspaces`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: 'test-channel' }),
  });
  assert.equal(create.status, 201);
  const { project } = await create.json();
  try {
    const read = await fetch(`http://127.0.0.1:${port}/api/agent/v1/workspaces/${encodeURIComponent(project.projectKey)}`);
    assert.equal(read.status, 200);
    const workflow = await fetch(`http://127.0.0.1:${port}/api/agent/v1/workspaces/${encodeURIComponent(project.projectKey)}/automation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'global', proactive: true, startStage: 'publish' }),
    });
    assert.equal(workflow.status, 202);
    const started = await workflow.json();
    const events = await fetch(`http://127.0.0.1:${port}/api/agent/v1/workspaces/${encodeURIComponent(project.projectKey)}/events`);
    const eventBody = await events.json();
    assert(eventBody.events.some((event) => event.workflowId === started.workflow.id && event.type === 'workflow_started'));
  } finally {
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}`, { method: 'DELETE', headers });
  }
});

test('mutations require CSRF and traversal never resolves', async () => {
  const mutation = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(mutation.status, 403);
  const traversal = await fetch(`http://127.0.0.1:${port}/api/projects/test-channel__..%252Fpackage`, { headers: { Cookie: cookie } });
  assert.equal(traversal.status, 400);
  const malformed = await fetch(`http://127.0.0.1:${port}/api/%E0%A4%A`, { headers: { Cookie: cookie } });
  assert.equal(malformed.status, 400);
});

test('configuration has one authoritative stage contract', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: cookie } });
  const body = await response.json();
  assert.equal(body.stages.length, 10);
  assert.deepEqual(body.stages.find((stage) => stage.id === 'script').substages, ['author', 'outline', 'draft', 'review', 'analyze', 'factcheck', 'critic']);
  const python = body.agents.find((agent) => agent.id === 'python');
  assert.equal(python.stages.includes('qc'), true);
  assert.equal(python.stages.includes('idea'), false);
});

test('artifact history validates both the project and relative path', async () => {
  const channels = await (await fetch(`http://127.0.0.1:${port}/api/channels`, { headers: { Cookie: cookie } })).json();
  const projectKey = channels.channels.flatMap((channel) => channel.videos)[0].projectKey;
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectKey)}/artifacts/history`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 400);
});

test('project settings and worker capabilities are enforced server-side', async () => {
  const channels = await (await fetch(`http://127.0.0.1:${port}/api/channels`, { headers: { Cookie: cookie } })).json();
  const projectKey = channels.channels.flatMap((channel) => channel.videos)[0].projectKey;
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const settings = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectKey)}`, { method: 'PATCH', headers, body: JSON.stringify({ settings: { targetDurationMin: -1 } }) });
  assert.equal(settings.status, 400);
  const invalidWorker = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectKey)}/stages/idea`, { method: 'PATCH', headers, body: JSON.stringify({ agent: 'python' }) });
  assert.equal(invalidWorker.status, 400);
  const validVisualWorker = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectKey)}/stages/visuals`, { method: 'PATCH', headers, body: JSON.stringify({ agent: 'python' }) });
  assert.equal(validVisualWorker.status, 200);
});

test('safely deleting a workspace cleans up files, database records, and rejects unauthorized deletion', async () => {
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channelId: 'test-channel' }),
  });
  assert.equal(createRes.status, 201);
  const { project } = await createRes.json();
  const createdKey = project.projectKey;

  const getRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { headers: { Cookie: cookie } });
  assert.equal(getRes.status, 200);

  const unauthRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(unauthRes.status, 403);

  const deleteRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { method: 'DELETE', headers });
  assert.equal(deleteRes.status, 200);
  const deleteBody = await deleteRes.json();
  assert.equal(deleteBody.ok, true);
  assert.equal(deleteBody.projectKey, createdKey);

  const afterGetRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { headers: { Cookie: cookie } });
  assert.equal(afterGetRes.status, 404);
});

test('selecting an idea persists choice, updates project brief, and syncs project title', async () => {
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channelId: 'test-channel' }),
  });
  assert.equal(createRes.status, 201);
  const { project } = await createRes.json();
  const createdKey = project.projectKey;

  try {
    const selectRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}/idea/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 'v1',
        ideaIndex: 1,
        idea: {
          index: 1,
          title: 'Example documentary question',
          pitch: 'An investigative inquiry into a documented historical claim.',
          angle: 'Evidence vs. assumption',
          ratings: { tension: '4', evidence: '5', visual: '5' },
          whyNow: 'The question remains relevant to modern audiences.',
          visuals: 'Evidence cards and explanatory diagrams.',
        },
        updateTitle: true,
      }),
    });
    assert.equal(selectRes.status, 200);
    const selectBody = await selectRes.json();
    assert.equal(selectBody.ok, true);
    assert.equal(selectBody.project.title, 'Example documentary question');
    assert.equal(selectBody.project.stages.idea.data.selectedIdea.title, 'Example documentary question');
    assert.equal(selectBody.project.stages.idea.data.selectedIdea.index, 1);

    assert(selectBody.artifacts.some((a) => a.relativePath === '00_project/project_brief.md'));
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { method: 'DELETE', headers });
  }
});

test('research discard endpoint appends to material_discarded.md and updates claim ledger', async () => {
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channelId: 'test-channel' }),
  });
  assert.equal(createRes.status, 201);
  const { project } = await createRes.json();
  const createdKey = project.projectKey;

  try {
    const discardRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}/research/discard`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        claimId: 'CLM-001',
        claimText: 'A source makes a claim that lacks supporting evidence.',
        reason: 'The claim has no accountable primary evidence',
      }),
    });
    assert.equal(discardRes.status, 200);
    const body = await discardRes.json();
    assert.equal(body.ok, true);
    assert(body.artifacts.some((a) => a.relativePath === '01_research/material_discarded.md'));
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { method: 'DELETE', headers });
  }
});

test('visuals studio manifest, asset patch, and render endpoints work correctly', async () => {
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channelId: 'test-channel' }),
  });
  assert.equal(createRes.status, 201);
  const { project } = await createRes.json();
  const createdKey = project.projectKey;

  try {
    const projectDir = path.join(__dirname, '..', '..', 'channels', 'test-channel', 'videos', project.slug);
    const plansDir = path.join(projectDir, '04_visuals', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    const planFile = path.join(plansDir, 'asset_plan_v1.json');
    const samplePlan = [
      { id: 'ASSET_001', type: 'GEN', description: 'Ancient library in Example Topic', prompt: 'Ancient Example Topic university at dawn, 16:9, warm golden hour' },
      { id: 'ASSET_002', type: 'PHOTO', description: 'Archaeological excavation site', prompt: 'Archaeological site photo' },
    ];
    fs.writeFileSync(planFile, JSON.stringify(samplePlan, null, 2), 'utf8');

    // Test GET manifest
    const manifestRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}/visuals/manifest`, { headers: { cookie } });
    assert.equal(manifestRes.status, 200);
    const manifestData = await manifestRes.json();
    assert.equal(manifestData.summary.total, 2);
    assert.equal(manifestData.assets[0].id, 'ASSET_001');
    assert.equal(manifestData.assets[0].type, 'GEN');

    // Test PATCH asset
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}/visuals/asset`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        assetId: 'ASSET_001',
        prompt: 'Updated prompt with dramatic lighting',
        approvalStatus: 'approved',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.ok, true);
    assert.equal(patchData.asset.prompt, 'Updated prompt with dramatic lighting');
    assert.equal(patchData.asset.approvalStatus, 'approved');

    // Test render single dispatch
    const renderRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}/visuals/render-single`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ assetId: 'ASSET_001', dryRun: true }),
    });
    assert.equal(renderRes.status, 202);
    const renderData = await renderRes.json();
    assert.equal(renderData.ok, true);
    assert.equal(renderData.run.stageId, 'visuals');

    // Test batch render pending queue via /api/jobs with generate
    const batchRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectKey: createdKey, stageId: 'visuals', substage: 'generate', skipRequirementsCheck: true }),
    });
    assert.equal(batchRes.status, 202);
    const batchData = await batchRes.json();
    assert.equal(batchData.run.stageId, 'visuals');
    assert.equal(batchData.run.substage, 'generate');
    assert.equal(batchData.run.adapter, 'python');
    await fetch(`http://127.0.0.1:${port}/api/jobs/${encodeURIComponent(batchData.run.id)}`, { method: 'DELETE', headers });

    // Test batch render alias 'render' maps to 'generate' without error
    const aliasRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectKey: createdKey, stageId: 'visuals', substage: 'render', skipRequirementsCheck: true }),
    });
    assert.equal(aliasRes.status, 202);
    const aliasData = await aliasRes.json();
    assert.equal(aliasData.run.stageId, 'visuals');
    assert.equal(aliasData.run.substage, 'generate');
    await fetch(`http://127.0.0.1:${port}/api/jobs/${encodeURIComponent(aliasData.run.id)}`, { method: 'DELETE', headers });

    // Test upscale selected dispatch on a second workspace
    const createRes2 = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers,
    body: JSON.stringify({ channelId: 'test-channel' }),
    });
    const { project: project2 } = await createRes2.json();
    const createdKey2 = project2.projectKey;
    try {
      const upscaleRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey2)}/visuals/upscale-selected`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(upscaleRes.status, 202);
      const upscaleData = await upscaleRes.json();
      assert.equal(upscaleData.ok, true);
      assert.equal(upscaleData.run.stageId, 'visuals');
    } finally {
      await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey2)}`, { method: 'DELETE', headers });
    }
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(createdKey)}`, { method: 'DELETE', headers });
  }
});

test('Editorial Blueprint migrates legacy plans, versions beat edits, and reconciles timing', async () => {
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
  const create = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ channelId: 'test-channel' }) });
  const { project } = await create.json();
  const projectDir = path.join(__dirname, '..', '..', 'channels', 'test-channel', 'videos', project.slug);
  try {
    const plans = path.join(projectDir, '04_visuals', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'asset_plan_v1.json'), JSON.stringify([{ id: 'ASSET_001', type: 'GEN', description: 'Reconstructed manuscript room', prompt: 'period accurate manuscript room' }]), 'utf8');
    const get = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/editorial-blueprint`, { headers: { cookie } });
    const legacy = await get.json();
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.blueprint.beats[0].id, 'BEAT_001');
    const edit = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/editorial-blueprint/beats/BEAT_001`, {
      method: 'POST', headers, body: JSON.stringify({ patch: { visual: { motion: { type: 'pan_left', rationale: 'Read across the manuscript.' } }, status: 'approved' } }),
    });
    const edited = await edit.json();
    assert.equal(edit.status, 200);
    assert.match(edited.blueprintRelative, /editorial_blueprint_v2\.json$/);
    assert.equal(edited.blueprint.beats[0].visual.motion.type, 'pan_left');
    const assetEdit = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/editorial-blueprint/assets/ASSET_001`, {
      method: 'POST', headers, body: JSON.stringify({ patch: { production: { generationPrompt: 'A historically grounded manuscript room, dawn through lattice windows', negativePrompt: 'watermark, modern objects' } } }),
    });
    const assetEdited = await assetEdit.json();
    assert.equal(assetEdit.status, 200);
    assert.equal(assetEdited.blueprint.assets[0].production.negativePrompt, 'watermark, modern objects');
    const reconcile = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/editorial-blueprint/reconcile-timing`, { method: 'POST', headers, body: JSON.stringify({ durationSeconds: 90 }) });
    const timed = await reconcile.json();
    assert.equal(reconcile.status, 200);
    assert.equal(timed.blueprint.timing.basis, 'voice_reconciled');
    assert.equal(timed.blueprint.beats[0].status, 'needs_review');
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}`, { method: 'DELETE', headers });
  }
});

test('audio manifest provisions music config and allows switching providers (ace_step vs yue)', async () => {
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
  const create = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ channelId: 'test-channel' }) });
  const { project } = await create.json();
  const projectDir = path.join(__dirname, '..', '..', 'channels', 'test-channel', 'videos', project.slug);
  try {
    const plansDir = path.join(projectDir, '03_audio', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, 'audio_plan_v1.json'), JSON.stringify({
      schemaVersion: 1,
      targetDurationSeconds: 60,
      musicCues: [
        { id: 'M01', brief: 'Mood: tranquil; tempo: 60 BPM', durationSeconds: 30 }
      ]
    }), 'utf8');

    // 1. GET audio manifest auto-provisions music pipeline config
    const manifestRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/audio/manifest`, { headers: { cookie } });
    assert.equal(manifestRes.status, 200);
    const manifestData = await manifestRes.json();
    assert.equal(manifestData.pipelineConfig?.music?.provider, 'ace_step');
    assert.equal(manifestData.pipelineConfig?.music?.script, 'tools/acestep_music_runner.py');
    assert.equal(manifestData.availableMusicProviders?.some((p) => p.id === 'ace_step'), true);
    assert.equal(manifestData.availableMusicProviders?.some((p) => p.id === 'yue'), true);
    assert.equal(manifestData.musicCues?.length, 1);
    assert.equal(manifestData.musicCues[0].id, 'M01');

    // 2. PATCH audio pipeline switches provider to yue
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/audio/pipeline`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ music: { provider: 'yue' } }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.pipelineConfig?.music?.provider, 'yue');
    assert.match(patchData.pipelineConfig?.music?.api_url, /8188/);

    // 3. POST audio/music/generate queues a music run
    const genRes = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}/audio/music/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cue: 'M01', provider: 'yue', dryRun: true }),
    });
    assert.equal(genRes.status, 202);
    const genData = await genRes.json();
    assert.equal(genData.run?.substage, 'music');
    assert.equal(genData.run?.stageId, 'audio');
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.projectKey)}`, { method: 'DELETE', headers });
  }
});
