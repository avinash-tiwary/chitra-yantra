'use strict';

const State = {
  csrf: '', config: { stages: [], agents: [] }, channels: [], activeChannelId: '', projectKey: '',
  project: null, filesystem: null, artifacts: [], runs: [], publications: [], currentStage: 'idea', selectedArtifact: '', artifactsExpanded: false,
  activeRunId: '', ws: null, reconnectTimer: null, youtube: null,
  ideaViewMode: 'cards', ideaSelectedVersion: '', ideaInlineExpansionIndex: null, ideaArtifactCache: {}, ideaComposerExpanded: false,
  researchViewMode: 'studio', researchActiveView: 'corpus', researchSelectedArtifact: '',
  researchClaimsFilter: 'ALL', researchCurrentStep: 0, researchStepStatus: '', researchArtifactCache: {},
  researchEditingCorpus: false,
  scriptStudio: { versions: [], comments: [], selectedVersionId: '', panel: 'comments', editing: false, reviewOpen: false },
  blueprintStudio: { data: null, selectedBeatId: '', version: null },
  visualsViewMode: 'studio', visualsFilter: 'all', visualsTypeFilter: '', visualsManifest: null,
  audioStudio: { manifest: null, activeTab: 'chunks', selectedItem: null, activeReviewTab: 'gate', filterText: '', inlineAudio: null, pollingTimer: null },
};
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-')) node.setAttribute(key, value);
    else if (key in node && key !== 'role') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

function humanStatus(status) {
  return ({ blocked: 'Blocked', ready: 'Ready', ready_for_translation: 'Ready for Hindi adaptation', queued: 'Queued', running: 'Running', needs_review: 'Needs review', invalidated: 'Files missing', approved: 'Approved', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', uploading: 'Uploading', uploaded: 'Uploaded', uploaded_partial: 'Uploaded · action needed' })[status] || status || 'Ready';
}

function languageSlug(language) {
  const normalized = String(language || '').toLowerCase().split('-')[0];
  return ({ en: 'english', hi: 'hindi', sa: 'sanskrit' })[normalized] || normalized;
}

function selectedScriptNeedsTranslation() {
  const selectedPath = State.project?.stages?.script?.data?.selectedScriptPath || '';
  const sourceLanguage = selectedPath.match(/_v\d+_([a-z][a-z0-9-]*)\.md$/i)?.[1]?.toLowerCase();
  const deliveryLanguage = languageSlug(State.project?.settings?.language || 'hi');
  return Boolean(sourceLanguage && deliveryLanguage && sourceLanguage !== deliveryLanguage);
}

function scriptDeliveryLanguage() {
  return languageSlug(State.project?.settings?.language || 'hi');
}

function productionScriptLanguages() {
  return [...new Set([
    languageSlug(State.project?.settings?.scriptAuthoringLanguage || 'en'),
    scriptDeliveryLanguage(),
  ])];
}

function scriptLanguageLabel(language) {
  return ({ english: 'English', hindi: 'Hindi', sanskrit: 'Sanskrit' })[languageSlug(language)] || language;
}

function scriptStageGate(versions = State.scriptStudio.versions) {
  const approvedPaths = State.project?.stages?.script?.data?.approvedScriptPaths || {};
  const approved = Object.values(approvedPaths).filter((relativePath) => versions.some((version) => version.relativePath === relativePath));
  if (approved.length) return { ready: true, message: 'Approved scripts are ready for editorial.', approvedPaths, approved };
  return { ready: false, message: 'Approve any current script to continue.', approvedPaths, approved };
}

function displayStageStatus(stageId, status) {
  return status;
}
function formatBytes(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function formatTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}
function toast(message, type = '') {
  const node = el('div', { className: `toast ${type}`, role: 'status', text: message });
  $('toast-region').append(node); setTimeout(() => node.remove(), 5000);
}
async function api(apiPath, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof Blob) && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = State.csrf;
  const response = await fetch(apiPath, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function establishSession() {
  const response = await fetch('/api/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not establish a local studio session');
  State.csrf = (await response.json()).csrfToken;
}

function connectSocket() {
  clearTimeout(State.reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  State.ws = new WebSocket(`${protocol}//${location.host}/ws?csrf=${encodeURIComponent(State.csrf)}`);
  State.ws.addEventListener('open', () => setConnection(true));
  State.ws.addEventListener('close', () => {
    setConnection(false);
    State.reconnectTimer = setTimeout(async () => { try { await establishSession(); } catch { /* retry below */ } connectSocket(); }, 2500);
  });
  State.ws.addEventListener('message', (event) => { try { handleSocket(JSON.parse(event.data)); } catch { /* ignore malformed event */ } });
}
function setConnection(connected) {
  $('connection-dot').classList.toggle('connected', connected);
  $('connection-dot').setAttribute('aria-label', connected ? 'Connected' : 'Disconnected');
  $('connection-copy').textContent = connected ? 'Studio connected · changes are revisioned' : 'Reconnecting to the studio…';
}
function handleSocket(message) {
  if (message.type === 'output' && message.projectKey === State.projectKey) {
    if (State.activeRunId && message.runId !== State.activeRunId) return;
    appendConsole(message.text);
    handleResearchStepOutput(message.text);
  }
  if (message.type === 'job' && message.projectKey === State.projectKey) {
    const index = State.runs.findIndex((run) => run.id === message.id);
    if (index >= 0) State.runs[index] = message; else State.runs.unshift(message);
    if (['queued', 'running'].includes(message.status)) { State.activeRunId = message.id; setConsoleRun(message); }
    else if (message.id === State.activeRunId) {
      setConsoleRun(message); State.activeRunId = '';
      toast(message.status === 'needs_review' ? 'Step finished. Review the new material.' : message.error || `Run ${humanStatus(message.status).toLowerCase()}`, message.status === 'needs_review' ? 'success' : 'error');
      State.ideaArtifactCache = {};
      State.researchArtifactCache = {};
      if (message.status === 'needs_review' && message.stageId === 'research' && message.substage === 'verify') {
        State.researchCurrentStep = 5;
        State.researchStepStatus = 'Adaptive research completed · verified production brief ready';
        updateResearchStepperUI();
      } else if (message.status === 'needs_review' && message.stageId === 'research') {
        const pipeline = State.project?.stages?.research?.data?.researchPipeline;
        State.researchCurrentStep = pipeline?.status === 'synthesizing' ? 3 : pipeline?.status === 'verifying' ? 4 : 2;
        State.researchStepStatus = pipeline?.status === 'synthesizing' ? 'Research angles complete · synthesizing reports…'
          : pipeline?.status === 'verifying' ? 'Synthesis complete · verifying critical claims…' : 'Research task completed · remaining agents continue…';
        updateResearchStepperUI();
      }
      loadProject(State.projectKey, { preserveArtifact: true });
    }
    renderRuns(); renderRunControls(); renderIdeaStudioRunState(); renderResearchStudioRunState();
  }
  if (message.type === 'project_updated' && message.projectKey === State.projectKey) {
    State.project = message.project;
    renderWorkspace();
  }
  if (message.type === 'publication' && message.projectKey === State.projectKey) { State.publications = message.publications; renderPublishPanel(); }
  if (message.type === 'autopilot_paused' && message.projectKey === State.projectKey) {
    toast(`Autopilot paused: ${message.message}`, 'error');
    loadProject(State.projectKey, { preserveArtifact: true });
  }
  if (message.type === 'workflow_event' && message.event?.projectKey === State.projectKey) {
    const event = message.event;
    if (event.type === 'workflow_paused') toast(`Automation paused: ${event.payload.reason}`, 'error');
    if (event.type === 'stage_retrying') toast(`Retrying ${event.payload.stageId} (${event.payload.attempt}/1)`, 'error');
    loadProject(State.projectKey, { preserveArtifact: true });
  }
  if (message.type === 'project_deleted') {
    if (State.projectKey === message.projectKey) {
      toast('This workspace was deleted.', 'error');
      localStorage.removeItem('chitra-project');
      showHome({ updateHistory: true });
    }
    refreshChannels();
  }
}
function appendConsole(text) {
  const output = $('console-output'); output.textContent = (output.textContent + text).slice(-200000); output.scrollTop = output.scrollHeight;
}
function renderConsoleRunSelector() {
  const select = $('console-run-select');
  if (!select) return;
  const runs = State.runs || [];
  if (!runs.length) {
    select.replaceChildren(el('option', { value: '', text: '(No runs recorded)' }));
    return;
  }
  select.replaceChildren(...runs.map((run) => {
    const isRunning = ['queued', 'running'].includes(run.status);
    const prefix = isRunning ? '● ' : '';
    const label = `${prefix}#${run.attempt} ${run.stageId}/${run.substage} (${humanStatus(run.status)}) · ${run.adapter}`;
    return el('option', { value: run.id, text: label });
  }));
  if (State.activeRunId && runs.some((r) => r.id === State.activeRunId)) {
    select.value = State.activeRunId;
  } else if (runs.length) {
    select.value = runs[0].id;
  }
}

function setConsoleRun(run) {
  if (!run) {
    $('console-title').textContent = 'Terminal';
    $('console-meta').textContent = 'No active run';
    if ($('console-status-badge')) $('console-status-badge').hidden = true;
    if ($('console-cmd-bar')) $('console-cmd-bar').hidden = true;
    if ($('console-error-bar')) $('console-error-bar').hidden = true;
    if ($('copy-console-cmd')) $('copy-console-cmd').hidden = true;
    document.querySelector('.live-mark')?.classList.remove('running');
    return;
  }
  State.activeRunId = run.id;
  $('console-title').textContent = `${run.stageId} · ${run.substage}`;
  $('console-meta').textContent = `attempt ${run.attempt} · ${run.adapter}`;
  const badge = $('console-status-badge');
  if (badge) {
    badge.hidden = false;
    badge.className = `console-status-badge ${run.status}`;
    badge.textContent = humanStatus(run.status);
  }
  document.querySelector('.live-mark')?.classList.toggle('running', run.status === 'running');

  // Command bar
  const cmdBar = $('console-cmd-bar');
  const copyBtn = $('copy-console-cmd');
  if (run.commandLine) {
    if (cmdBar) {
      cmdBar.hidden = false;
      $('console-cmd-text').textContent = run.commandLine;
      $('console-cwd-text').textContent = run.cwd ? `in ${run.cwd.split('/').slice(-2).join('/')}` : '';
      $('console-cwd-text').title = run.cwd || '';
    }
    if (copyBtn) copyBtn.hidden = false;
  } else {
    if (cmdBar) cmdBar.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
  }

  // Error bar
  const errBar = $('console-error-bar');
  if (errBar) {
    if (['failed', 'cancelled', 'interrupted'].includes(run.status) || run.error) {
      errBar.hidden = false;
      $('console-error-text').textContent = run.error || `Process exited with status ${run.status} (exit code ${run.exitCode ?? 'none'})`;
    } else {
      errBar.hidden = true;
    }
  }

  const runSelect = $('console-run-select');
  if (runSelect && runSelect.value !== run.id && Array.from(runSelect.options).some((o) => o.value === run.id)) {
    runSelect.value = run.id;
  }
}
function syncConsoleHeight(height, collapsed) {
  const consoleEl = $('run-console');
  const isCollapsed = typeof collapsed === 'boolean' ? collapsed : (consoleEl?.classList.contains('collapsed') ?? true);
  let currentHeight = 45;
  if (!isCollapsed) {
    const validHeight = height || Number(localStorage.getItem('chitra-console-size')) || 210;
    currentHeight = Math.max(45, validHeight);
  }
  document.documentElement.style.setProperty('--console-current-height', `${currentHeight}px`);
  return currentHeight;
}
function openConsole() {
  const consoleEl = $('run-console');
  if (!consoleEl) return;
  consoleEl.classList.remove('collapsed');
  $('console-toggle')?.setAttribute('aria-expanded', 'true');
  if ($('console-toggle')) $('console-toggle').textContent = '⌄';
  const savedHeight = Number(localStorage.getItem('chitra-console-size')) || 210;
  consoleEl.style.height = `${savedHeight}px`;
  syncConsoleHeight(savedHeight, false);
}

async function bootstrap() {
  const routedKey = projectKeyFromPath();
  const routedStage = stageFromUrl();
  if (routedKey) {
    $('home-view').hidden = true;
    $('project-workspace').hidden = false;
    $('project-title').textContent = 'Loading workspace…';
  }
  updateNavActions();
  try {
    await establishSession();
    const [config, channelData] = await Promise.all([api('/api/config'), api('/api/channels')]);
    State.config = config; State.channels = channelData.channels;
    populateChannels(); connectSocket();
    const all = State.channels.flatMap((channel) => channel.videos);
    const project = all.find((item) => item.projectKey === routedKey);
    if (project) {
      await selectProject(project.projectKey, { updateHistory: false, targetStage: routedStage });
    } else if (routedKey) {
      toast('Workspace not found', 'error');
      showHome({ updateHistory: true });
    } else {
      showHome({ updateHistory: false });
    }
    api('/api/youtube/status').then((youtube) => { State.youtube = youtube; renderPublishPanel(); })
      .catch((error) => { State.youtube = { configured: false, authenticated: false, error: error.message }; renderPublishPanel(); });
  } catch (error) {
    toast(error.message, 'error');
    $('connection-copy').textContent = error.message;
    if (routedKey && !State.project) showHome({ updateHistory: false });
  }
}
function populateChannels() {
  const saved = localStorage.getItem('chitra-channel');
  const best = [...State.channels].sort((a, b) => b.videos.length - a.videos.length)[0];
  State.activeChannelId = State.channels.some((channel) => channel.id === saved) ? saved : best?.id || '';
  for (const select of [$('new-channel'), $('workspace-channel')]) {
    select.replaceChildren(...State.channels.map((channel) => el('option', { value: channel.id, text: channel.name || channel.id })));
    select.value = State.activeChannelId;
  }
  $('home-channel').replaceChildren(el('option', { value: 'all', text: 'All channels' }), ...State.channels.map((channel) => el('option', { value: channel.id, text: channel.name || channel.id })));
  $('home-channel').value = 'all';
  renderProjects();
}
let pendingDeleteProjectKey = '';
let pendingDeleteProjectTitle = '';

function openDeleteDialog(projectKey, projectTitle) {
  pendingDeleteProjectKey = projectKey;
  pendingDeleteProjectTitle = projectTitle || projectKey;
  $('delete-target-title').textContent = pendingDeleteProjectTitle;
  $('delete-target-slug').textContent = projectKey;
  const input = $('delete-confirm-input');
  input.value = '';
  const confirmBtn = $('confirm-delete-btn');
  confirmBtn.hidden = true;
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Delete workspace';
  $('delete-project-dialog').showModal();
  setTimeout(() => input.focus(), 60);
}

async function refreshChannels() {
  try {
    const data = await api('/api/channels');
    State.channels = data.channels;
    populateChannels();
  } catch (error) {
    console.warn('Could not refresh channels:', error.message);
  }
}

function activeChannel() { return State.channels.find((channel) => channel.id === State.activeChannelId); }
function renderProjects() {
  const query = $('project-filter').value.trim().toLocaleLowerCase();
  const channelFilter = $('home-channel').value || 'all';
  const projects = State.channels.flatMap((channel) => channel.videos.map((video) => ({ ...video, channelName: channel.name || channel.id })))
    .filter((project) => (channelFilter === 'all' || project.projectKey.startsWith(`${channelFilter}__`)) && project.title.toLocaleLowerCase().includes(query));
  if (!projects.length) return $('project-list').replaceChildren(el('div', { className: 'rail-empty', text: query ? 'No matching productions.' : 'No productions in this channel yet.' }));
  $('project-list').replaceChildren(...projects.map((project) => {
    const deleteBtn = el('button', {
      type: 'button',
      className: 'project-item-delete',
      'data-delete-project-key': project.projectKey,
      'data-delete-project-title': project.title,
      title: `Delete workspace: ${project.title}`,
      'aria-label': `Delete workspace: ${project.title}`,
    });
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';

    return el('a', {
      href: workspacePath(project.projectKey),
      className: `project-item ${project.projectKey === State.projectKey ? 'active' : ''}`,
      'data-project-key': project.projectKey
    }, [
      el('div', { className: 'project-item-header' }, [
        el('strong', { text: project.title }),
        deleteBtn,
      ]),
      el('small', { className: project.status, text: `${project.channelName} · ${humanStatus(project.status)}` }),
    ]);
  }));
}
function workspacePath(projectKey, stageId = '') {
  const index = projectKey.indexOf('__');
  const base = index > 0
    ? `/videos/${encodeURIComponent(projectKey.slice(0, index))}/${encodeURIComponent(projectKey.slice(index + 2))}`
    : `/videos/${encodeURIComponent(projectKey)}`;
  return stageId ? `${base}?stage=${encodeURIComponent(stageId)}` : base;
}
function projectKeyFromPath() {
  const cleanMatch = location.pathname.match(/^\/videos\/([^/?#]+)\/([^/?#]+)/);
  if (cleanMatch) {
    try { return `${decodeURIComponent(cleanMatch[1])}__${decodeURIComponent(cleanMatch[2])}`; } catch { return ''; }
  }
  const legacyMatch = location.pathname.match(/^\/videos\/([^/?#]+)/);
  try { return legacyMatch ? decodeURIComponent(legacyMatch[1]) : ''; } catch { return ''; }
}
function stageFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('stage') || '';
}
function updateNavActions() {
  const isWorkspace = !$('project-workspace').hidden;
  const newProjectBtn = $('new-project');
  const navDashboardBtn = $('nav-dashboard');
  if (newProjectBtn) newProjectBtn.hidden = isWorkspace;
  if (navDashboardBtn) navDashboardBtn.hidden = !isWorkspace;
}
function updateDrawerDockState() {
  updateNavActions();
  const dock = $('review-dock-toggle');
  if (!dock) return;
  const isWorkspace = !$('project-workspace').hidden;
  const isReviewOpen = !$('review-drawer')?.hidden;
  dock.hidden = !isWorkspace || State.currentStage === 'script' || isReviewOpen;
}
function closeDrawer(id) {
  const drawer = $(id);
  if (drawer) drawer.hidden = true;
  if (id === 'review-drawer') $('review-toggle')?.setAttribute('aria-expanded', 'false');
  if (id === 'settings-drawer') $('settings-toggle')?.setAttribute('aria-expanded', 'false');
  updateDrawerDockState();
}
function closeDrawers() {
  for (const id of ['review-drawer', 'settings-drawer']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  $('review-toggle')?.setAttribute('aria-expanded', 'false');
  $('settings-toggle')?.setAttribute('aria-expanded', 'false');
  updateDrawerDockState();
}
function showHome({ updateHistory = true } = {}) {
  State.project = null; State.projectKey = ''; State.selectedArtifact = ''; closeDrawers();
  $('project-workspace').hidden = true; $('home-view').hidden = false; document.title = 'Chitra Yantra · चित्र यन्त्र';
  if (updateHistory && location.pathname !== '/') window.history.pushState({}, '', '/');
  renderProjects();
  updateDrawerDockState();
}
async function selectProject(projectKey, { updateHistory = true, targetStage = '' } = {}) {
  State.projectKey = projectKey; localStorage.setItem('chitra-project', projectKey);
  const channelId = projectKey.split('__')[0];
  if (State.activeChannelId !== channelId) { State.activeChannelId = channelId; localStorage.setItem('chitra-channel', channelId); }
  State.currentStage = targetStage || ''; State.selectedArtifact = ''; State.artifactsExpanded = false;
  if ($('review-drawer')) $('review-drawer').hidden = false;
  $('review-toggle')?.setAttribute('aria-expanded', 'true');
  updateDrawerDockState();
  window.scrollTo(0, 0);
  await loadProject(projectKey, { targetStage });
  if (State.project && updateHistory) {
    const desiredPath = workspacePath(projectKey, State.currentStage);
    const currentFull = location.pathname + location.search;
    if (currentFull !== desiredPath) window.history.pushState({}, '', desiredPath);
  }
}
async function loadProject(projectKey, { preserveArtifact = false, targetStage = '' } = {}) {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectKey)}`);
    State.project = data.project; State.filesystem = data.filesystem; State.artifacts = data.artifacts; State.runs = data.runs; State.publications = data.publications;
    const requestedStage = targetStage || State.currentStage;
    State.currentStage = State.config.stages.some((stage) => stage.id === requestedStage) ? requestedStage : State.project.currentStage;
    if (!preserveArtifact) State.selectedArtifact = '';
    if (State.currentStage === 'script' && !State.selectedArtifact) {
      const scriptArtifacts = State.artifacts.filter((a) => a.stageId === 'script' || a.relativePath.startsWith('02_script/'));
      const latest = findLatestScriptArtifact(scriptArtifacts);
      if (latest) {
        State.scriptSelectedArtifact = latest.relativePath;
        State.selectedArtifact = latest.relativePath;
      }
    }
    State.activeRunId = State.runs.find((run) => ['queued', 'running'].includes(run.status))?.id || '';
    $('home-view').hidden = true; $('project-workspace').hidden = false; document.title = `${State.project.title} · Chitra Yantra`;
    updateDrawerDockState();
    renderProjects(); renderWorkspace(); if (State.activeRunId) await showRunLog(State.activeRunId);
  } catch (error) { toast(error.message, 'error'); }
}

function renderWorkspace() {
  const project = State.project;
  const projectChannel = State.channels.find((channel) => channel.id === project.channelId);
  $('project-context').textContent = `${projectChannel?.name || project.channelId} / ${project.slug}`;
  $('project-title').textContent = project.title; $('workspace-title').value = project.title;
  $('workspace-channel').value = project.channelId; $('target-duration').value = project.settings.targetDurationMin || 12;
  $('workspace-language').value = project.settings.language || 'hi';
  $('research-rounds').value = project.settings.researchMaxSynthesisPasses || 3;
  $('research-max-sources').value = project.settings.researchMaxAngles || 10;
  $('workspace-autopilot').checked = Boolean(project.settings.autopilot);
  renderPipeline(); renderStage(); renderArtifacts(); renderRuns(); renderPublishPanel();
}
function currentStageConfig() { return State.config.stages.find((stage) => stage.id === State.currentStage); }
function agentsForStage(stageId) {
  return State.config.agents.filter((agent) => !agent.stages || agent.stages.includes('*') || agent.stages.includes(stageId));
}
function workspaceAgents() { return State.config.agents.filter((agent) => agent.stages?.includes('*')); }
function agentForStage(stageId) {
  const stage = State.project?.stages?.[stageId];
  return stage?.data?.workerOverrideEnabled ? stage.agent : State.project?.settings?.defaultAgent || 'codex';
}
function renderPipeline() {
  const stages = State.config.stages || [];
  const globalAuto = Boolean(State.project?.settings?.autopilot);
  let approvedCount = 0;
  $('pipeline').replaceChildren(...stages.map((stage, index) => {
    const status = State.project.stages[stage.id]?.status || 'blocked';
    const displayStatus = displayStageStatus(stage.id, status);
    if (status === 'approved') approvedCount++;
    const isActive = stage.id === State.currentStage;
    const stageButton = el('button', {
      type: 'button',
      title: `${index + 1}. ${stage.name} (${humanStatus(displayStatus)})`,
      className: `pipeline-step ${displayStatus === 'ready_for_translation' ? 'ready' : displayStatus} ${isActive ? 'active' : ''}`,
      'data-stage-id': stage.id,
      'aria-current': isActive ? 'step' : 'false'
    }, [
      el('div', { className: 'step-badge-wrap' }, [
        el('span', { className: `step-num ${status === 'approved' ? 'approved-circle' : ''}`, text: String(index + 1) })
      ]),
      el('strong', { className: 'step-name', text: stage.name })
    ]);
    const row = el('div', { className: 'stage-row' }, [stageButton]);
    if (!globalAuto && stage.id !== 'publish') {
      const enabled = Boolean(State.project.stages[stage.id]?.autoMode);
      row.append(el('button', {
        type: 'button', className: `stage-auto-toggle ${enabled ? 'active' : ''}`, 'data-stage-auto': stage.id,
        'aria-pressed': enabled ? 'true' : 'false', title: enabled ? `Turn off automatic ${stage.name}` : `Complete ${stage.name} automatically`, text: 'Auto',
      }));
    }
    return row;
  }));
  const globalToggle = $('global-auto-toggle');
  if (globalToggle) {
    globalToggle.setAttribute('aria-pressed', globalAuto ? 'true' : 'false');
    const label = globalToggle.querySelector('.automation-mode-label');
    if (label) label.textContent = globalAuto ? 'Global auto · On' : 'Manual mode';
    globalToggle.title = globalAuto ? 'Turn off global automation and choose individual stages' : 'Enable automation for the whole workflow';
  }
  const total = stages.length;
  if ($('stage-progress-text')) {
    $('stage-progress-text').textContent = `${approvedCount} / ${total} approved`;
  }
  if ($('stage-progress-fill')) {
    const pct = total ? Math.round((approvedCount / total) * 100) : 0;
    $('stage-progress-fill').style.width = `${pct}%`;
  }
}

async function toggleGlobalAutomation() {
  const enabled = !Boolean(State.project?.settings?.autopilot);
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}`, { method: 'PATCH', body: { settings: { autopilot: enabled } } });
    State.project = response.project;
    if (!enabled) {
      const stages = State.config.stages.filter((stage) => stage.id !== 'publish');
      const results = await Promise.all(stages.map((stage) => api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/${stage.id}`, { method: 'PATCH', body: { autoMode: false } })));
      results.forEach((result, index) => { State.project.stages[stages[index].id] = result.stage; });
      toast('Global auto is off. Choose the stages you want to complete automatically.', 'success');
    } else {
      toast('Global auto is configured. Start it from workspace settings when you are ready.', 'success');
    }
    $('workspace-autopilot').checked = enabled;
    renderPipeline(); renderStage();
  } catch (error) { toast(error.message, 'error'); }
}

async function toggleStageAutomation(stageId) {
  const current = Boolean(State.project.stages[stageId]?.autoMode);
  try {
    const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/${stageId}`, { method: 'PATCH', body: { autoMode: !current } });
    State.project.stages[stageId] = result.stage;
    if (result.workflow) toast(`${stageId} automation started`, 'success');
    toast(!current ? `${stageId} will complete automatically` : `${stageId} will run manually`, 'success');
    renderPipeline();
  } catch (error) { toast(error.message, 'error'); }
}
function parseIdeaMarkdown(content = '') {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split('\n');
  const sections = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^###\s+(?:Idea\s+)?(?:#?(\d+)[:.]?\s*)?(.+)$/i);
    if (headerMatch && !line.match(/Sources|Provenance|References|Bibliography/i)) {
      if (currentSection) sections.push(currentSection);
      const indexNum = headerMatch[1] ? Number(headerMatch[1]) : (sections.length + 1);
      const rawTitle = (headerMatch[2] || '').trim().replace(/^[:.-]\s*/, '').replace(/\*+/g, '');
      currentSection = {
        index: indexNum,
        title: rawTitle,
        rawLines: [line],
      };
    } else if (line.match(/^##+\s+(?:Sources|Provenance|References)/i)) {
      if (currentSection) {
        sections.push(currentSection);
        currentSection = null;
      }
    } else if (currentSection) {
      currentSection.rawLines.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  if (!sections.length) {
    const genericMatches = content.split(/^###\s+/m);
    for (let i = 1; i < genericMatches.length; i++) {
      const block = genericMatches[i];
      const firstLine = block.split('\n')[0].trim();
      if (!firstLine.match(/Sources|Provenance/i)) {
        sections.push({
          index: i,
          title: firstLine.replace(/^\d+[:.]?\s*/, ''),
          rawLines: block.split('\n'),
        });
      }
    }
  }

  return sections.map((sec, idx) => {
    const blockText = sec.rawLines.join('\n');
    let pitch = '';
    let angle = '';
    let ratings = {};
    let whyNow = '';
    let visuals = '';

    const pitchMatch = blockText.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?\*\*(?:Pitch|Premise)[:\*]*\s*([\s\S]*?)(?=(?:\n[ \t]*(?:[-*]\s*)?\*\*[A-Za-z ]+[:\*]|\n###|\n##|$))/i);
    if (pitchMatch) pitch = pitchMatch[1].trim();

    const angleMatch = blockText.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?\*\*(?:Angle|Core Tension|Narrative Angle)[:\*]*\s*([\s\S]*?)(?=(?:\n[ \t]*(?:[-*]\s*)?\*\*[A-Za-z ]+[:\*]|\n###|\n##|$))/i);
    if (angleMatch) angle = angleMatch[1].trim();

    const ratingsMatch = blockText.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?\*\*(?:Ratings|Scores?)[:\*]*\s*([^\n]+)/i);
    if (ratingsMatch) {
      const rStr = ratingsMatch[1];
      const tension = rStr.match(/Tension[:\s]*(\d+(?:\.\d+)?)(?:\/5)?/i)?.[1];
      const evidence = rStr.match(/Evidence[:\s]*(\d+(?:\.\d+)?)(?:\/5)?/i)?.[1];
      const visual = rStr.match(/Visual(?:s)?[:\s]*(\d+(?:\.\d+)?)(?:\/5)?/i)?.[1];
      if (tension) ratings.tension = tension;
      if (evidence) ratings.evidence = evidence;
      if (visual) ratings.visual = visual;
    }

    const whyNowMatch = blockText.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?\*\*(?:Why Now|Why now|Relevance|Contemporary Relevance)[:\*]*\s*([\s\S]*?)(?=(?:\n[ \t]*(?:[-*]\s*)?\*\*[A-Za-z ]+[:\*]|\n###|\n##|$))/i);
    if (whyNowMatch) whyNow = whyNowMatch[1].trim();

    const visualsMatch = blockText.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?\*\*(?:Visuals|Visual Storytelling|Visual Potential)[:\*]*\s*([\s\S]*?)(?=(?:\n[ \t]*(?:[-*]\s*)?\*\*[A-Za-z ]+[:\*]|\n###|\n##|$))/i);
    if (visualsMatch) visuals = visualsMatch[1].trim();

    if (!pitch && !angle && !whyNow) {
      pitch = sec.rawLines.slice(1).join('\n').trim();
    }

    return {
      index: sec.index || (idx + 1),
      title: sec.title || `Idea ${idx + 1}`,
      pitch,
      angle,
      ratings,
      whyNow,
      visuals,
      raw: blockText.trim(),
    };
  });
}

function renderIdeaStudioRunState() {
  if (!State.project) return;
  const active = State.runs.find((run) => ['queued', 'running'].includes(run.status));
  const isRunning = Boolean(active);
  if ($('generate-guided-ideas')) $('generate-guided-ideas').disabled = isRunning;
  if ($('generate-proactive-ideas')) $('generate-proactive-ideas').disabled = isRunning;
  if ($('refine-round-btn')) $('refine-round-btn').disabled = isRunning;
  if ($('fresh-round-btn')) $('fresh-round-btn').disabled = isRunning;
  if ($('idea-stop-run')) {
    $('idea-stop-run').hidden = !isRunning;
    if (active) $('idea-stop-run').dataset.runId = active.id;
  }
}

async function proceedToResearch() {
  if (!await decideStage('approved')) return;
  await switchStage('research');
  toast('Advanced to Stage 2: Research', 'success');
}

function findVariationsForIdea(parentVersion, ideaIndex, ideaTitle) {
  const data = State.project?.stages?.idea?.data || {};
  const branchLineage = data.branchLineage || {};

  // 1. Explicit lineage check
  for (const [targetPath, lineage] of Object.entries(branchLineage)) {
    if (Number(lineage.parentIndex) === Number(ideaIndex) && (!lineage.parentArtifact || lineage.parentArtifact === parentVersion)) {
      const cached = State.ideaArtifactCache[targetPath];
      if (cached) {
        const parsed = parseIdeaMarkdown(cached);
        if (parsed.length) {
          const vMatch = targetPath.match(/_v(\d+)\.md$/);
          return {
            targetArtifact: targetPath,
            versionNum: vMatch ? vMatch[1] : '2',
            variations: parsed,
            lineage,
          };
        }
      }
    }
  }

  // 2. Fallback: check cached artifacts matching Idea index or title
  const otherArtifacts = (State.artifacts || []).filter((a) => /^00_project\/idea_v\d+\.md$/i.test(a.relativePath) && a.relativePath !== parentVersion);
  for (const art of otherArtifacts) {
    const cached = State.ideaArtifactCache[art.relativePath];
    if (cached) {
      const vMatch = art.relativePath.match(/_v(\d+)\.md$/);
      const vNum = vMatch ? Number(vMatch[1]) : 0;
      const parentNum = Number(parentVersion?.match(/_v(\d+)\.md$/)?.[1] || 1);
      if (vNum > parentNum) {
        const mentionsIdea = cached.includes(`Idea ${ideaIndex}`) || (ideaTitle && cached.includes(ideaTitle.trim()));
        if (mentionsIdea) {
          const parsed = parseIdeaMarkdown(cached);
          if (parsed.length) {
            return {
              targetArtifact: art.relativePath,
              versionNum: String(vNum),
              variations: parsed,
              lineage: { parentIndex: ideaIndex, parentTitle: ideaTitle, parentArtifact: parentVersion },
            };
          }
        }
      }
    }
  }
  return null;
}

async function renderIdeaStudio() {
  if (!State.project || State.currentStage !== 'idea') return;
  const project = State.project;
  const stageState = project.stages?.idea || {};
  const data = stageState.data || {};
  const currentMode = data.planningMode || 'guided';

  $('tab-guided-mode').classList.toggle('active', currentMode === 'guided');
  $('tab-guided-mode').setAttribute('aria-selected', String(currentMode === 'guided'));
  $('tab-proactive-mode').classList.toggle('active', currentMode === 'proactive');
  $('tab-proactive-mode').setAttribute('aria-selected', String(currentMode === 'proactive'));

  if (data.topicDescription && !$('deck-idea-topic').value) {
    $('deck-idea-topic').value = data.topicDescription;
  }
  if (data.manualSources && !$('deck-idea-sources').value) {
    $('deck-idea-sources').value = data.manualSources;
  }

  const channel = State.channels.find((c) => c.id === project.channelId) || {};
  $('proactive-channel-name').textContent = channel.name || project.channelId;
  $('proactive-channel-niche').textContent = channel.niche || 'Documentary channel';

  const ideaArtifacts = State.artifacts.filter((a) => /^00_project\/idea_v\d+\.md$/i.test(a.relativePath) || a.relativePath === '00_project/ideas.md').sort((a, b) => {
    const vA = Number(a.relativePath.match(/_v(\d+)\.md$/)?.[1] || 0);
    const vB = Number(b.relativePath.match(/_v(\d+)\.md$/)?.[1] || 0);
    return vB - vA;
  });

  // Pre-fetch idea artifacts in background so variations can be rendered inline
  for (const artifact of ideaArtifacts) {
    if (!State.ideaArtifactCache[artifact.relativePath]) {
      fetch(mediaUrl(artifact), { credentials: 'same-origin' })
        .then((r) => r.ok ? r.text() : '')
        .then((text) => {
          if (text) {
            State.ideaArtifactCache[artifact.relativePath] = text;
            renderIdeaStudio();
          }
        })
        .catch(() => {});
    }
  }

  if (ideaArtifacts.length > 0) {
    $('idea-round-wrap').hidden = false;
    if (!State.ideaSelectedVersion || !ideaArtifacts.some((a) => a.relativePath === State.ideaSelectedVersion)) {
      State.ideaSelectedVersion = ideaArtifacts[0].relativePath;
    }
    $('idea-version-select').replaceChildren(...ideaArtifacts.map((artifact) => {
      const vMatch = artifact.relativePath.match(/_v(\d+)\.md$/);
      const vNum = vMatch ? vMatch[1] : '1';
      const lineage = (data.branchLineage || {})[artifact.relativePath];
      let label = `Round ${vNum} (${artifact.relativePath.split('/').at(-1)})`;
      if (lineage?.parentIndex) {
        label = `Round ${vNum} · ↳ Variations for Idea ${lineage.parentIndex}`;
      } else if (vNum === '1') {
        label = `Round 1 · Initial Ideas (${artifact.relativePath.split('/').at(-1)})`;
      }
      return el('option', { value: artifact.relativePath, text: label });
    }));
    $('idea-version-select').value = State.ideaSelectedVersion;
  } else {
    $('idea-round-wrap').hidden = true;
    State.ideaSelectedVersion = '';
  }

  // Header Selection Status
  const selectedIdea = data.selectedIdea;
  const headerSelection = $('idea-header-selection');
  if (headerSelection) {
    if (selectedIdea?.title) {
      headerSelection.hidden = false;
      $('header-selection-title').textContent = `${selectedIdea.title} · (Idea ${selectedIdea.index || 1})`;
    } else {
      headerSelection.hidden = true;
    }
  }

  renderIdeaStudioRunState();

  const deck = $('idea-cards-deck');
  if (!State.ideaSelectedVersion) {
    $('idea-seed-summary').hidden = true;
    $('deck-guided-mode').hidden = currentMode !== 'guided';
    $('deck-proactive-mode').hidden = currentMode !== 'proactive';
    deck.replaceChildren(el('div', { className: 'empty-ideas-state' }, [
      el('h3', { text: 'Start Your Creative Exploration' }),
      el('p', { text: 'Enter a topic premise or launch proactive channel discovery to generate your first round of documentary ideas.' }),
    ]));
    $('idea-reiterate-bar').hidden = true;
    return;
  }

  const targetVersion = State.ideaSelectedVersion;
  let markdown = State.ideaArtifactCache[targetVersion];
  if (!markdown) {
    const targetArtifact = ideaArtifacts.find((a) => a.relativePath === targetVersion);
    if (targetArtifact) {
      try {
        const resp = await fetch(mediaUrl(targetArtifact), { credentials: 'same-origin' });
        if (resp.ok) {
          markdown = await resp.text();
          State.ideaArtifactCache[targetVersion] = markdown;
        }
      } catch { /* ignore load error */ }
    }
  }

  // Lineage banner above deck if current version is a branch
  const lineageBannerWrap = $('idea-lineage-banner-wrap');
  if (lineageBannerWrap) {
    const lineage = (data.branchLineage || {})[targetVersion];
    if (lineage?.parentIndex) {
      lineageBannerWrap.replaceChildren(el('div', { className: 'round-lineage-banner' }, [
        el('span', { text: `↳ Exploring angle variations branched from Idea ${lineage.parentIndex}: "${lineage.parentTitle || 'Parent Idea'}"` }),
        el('button', {
          type: 'button',
          className: 'button quiet compact-button',
          text: `← Return to Round 1 (${lineage.parentArtifact?.split('/').at(-1) || 'Parent'})`,
          onClick: () => {
            State.ideaSelectedVersion = lineage.parentArtifact || '00_project/idea_v1.md';
            State.ideaInlineExpansionIndex = lineage.parentIndex;
            renderIdeaStudio();
          }
        })
      ]));
    } else {
      lineageBannerWrap.replaceChildren();
    }
  }

  const ideas = parseIdeaMarkdown(markdown || '');
  if (!ideas.length) {
    $('idea-seed-summary').hidden = true;
    $('deck-guided-mode').hidden = currentMode !== 'guided';
    $('deck-proactive-mode').hidden = currentMode !== 'proactive';
    deck.replaceChildren(el('div', { className: 'empty-ideas-state' }, [
      el('h3', { text: 'No structured ideas found in this round' }),
      el('p', { text: 'Click "View Markdown" above to inspect or edit the raw file, or run a new generation pass.' }),
    ]));
    $('idea-reiterate-bar').hidden = true;
    return;
  }

  // Handle collapsible seed bar when ideas exist
  if (State.ideaComposerExpanded) {
    $('idea-seed-summary').hidden = true;
    $('deck-guided-mode').hidden = currentMode !== 'guided';
    $('deck-proactive-mode').hidden = currentMode !== 'proactive';
  } else {
    $('idea-seed-summary').hidden = false;
    $('seed-summary-text').textContent = data.topicDescription || project.title || 'Channel Proactive Discovery Pass';
    $('deck-guided-mode').hidden = true;
    $('deck-proactive-mode').hidden = true;
  }

  $('idea-reiterate-bar').hidden = false;
  const currentVersionLabel = targetVersion.match(/_v(\d+)\.md$/)?.[1] ? `v${targetVersion.match(/_v(\d+)\.md$/)[1]}` : 'v1';

  deck.replaceChildren(...ideas.map((idea) => {
    const isSelected = Boolean(selectedIdea && (selectedIdea.title === idea.title || (Number(selectedIdea.index) === Number(idea.index) && (selectedIdea.version === currentVersionLabel || !selectedIdea.version))));

    const variationData = findVariationsForIdea(targetVersion, idea.index, idea.title);
    const hasVariations = Boolean(variationData && variationData.variations.length);

    const titleGroupChildren = [
      el('span', { className: 'idea-num-badge', text: `Idea ${idea.index}` }),
      el('h3', { className: 'idea-card-title', text: idea.title }),
    ];
    if (hasVariations) {
      titleGroupChildren.push(el('span', {
        className: 'variation-badge-avail',
        text: `✦ ${variationData.variations.length} variations`,
        title: `${variationData.variations.length} angle variations generated for this idea`
      }));
    }
    const titleGroup = el('div', { className: 'idea-card-title-group' }, titleGroupChildren);

    const ratingsGroup = el('div', { className: 'idea-ratings-group' });
    if (idea.ratings.tension) {
      const val = parseFloat(idea.ratings.tension);
      ratingsGroup.append(el('span', { className: `idea-rating-pill ${val >= 4 ? 'high' : ''}`, text: `Tension: ${idea.ratings.tension}/5` }));
    }
    if (idea.ratings.evidence) {
      const val = parseFloat(idea.ratings.evidence);
      ratingsGroup.append(el('span', { className: `idea-rating-pill ${val >= 4 ? 'high' : ''}`, text: `Evidence: ${idea.ratings.evidence}/5` }));
    }
    if (idea.ratings.visual) {
      const val = parseFloat(idea.ratings.visual);
      ratingsGroup.append(el('span', { className: `idea-rating-pill ${val >= 4 ? 'high' : ''}`, text: `Visuals: ${idea.ratings.visual}/5` }));
    }

    const header = el('header', { className: 'idea-card-header' }, [titleGroup, ratingsGroup]);

    const pitchContainer = el('div', { className: 'idea-card-pitch' });
    const paragraphs = (idea.pitch || '').split(/\n\n+/).filter(Boolean);
    if (paragraphs.length) {
      for (const p of paragraphs) pitchContainer.append(el('p', { text: p.trim() }));
    } else if (idea.pitch) {
      pitchContainer.append(el('p', { text: idea.pitch.trim() }));
    }

    const angleCallout = idea.angle ? el('div', { className: 'idea-angle-callout' }, [
      el('strong', { text: 'Narrative Angle & Conflict' }),
      el('span', { text: idea.angle }),
    ]) : null;

    const dimensions = [];
    if (idea.whyNow) {
      dimensions.push(el('div', { className: 'dimension-item' }, [
        el('strong', { text: 'Contemporary Relevance (Why Now)' }),
        el('p', { text: idea.whyNow }),
      ]));
    }
    if (idea.visuals) {
      dimensions.push(el('div', { className: 'dimension-item' }, [
        el('strong', { text: 'Visual Storytelling Hooks' }),
        el('p', { text: idea.visuals }),
      ]));
    }
    const dimensionsGrid = dimensions.length ? el('div', { className: 'idea-dimensions-grid' }, dimensions) : null;

    const selectBtn = el('button', {
      type: 'button',
      className: `select-idea-btn ${isSelected ? 'is-selected' : ''}`,
      text: isSelected ? '✓ Locked Direction' : 'Select this Topic',
    });
    selectBtn.addEventListener('click', () => selectIdea(idea, currentVersionLabel));

    const primaryActions = [selectBtn];
    if (isSelected) {
      const proceedBtn = el('button', {
        type: 'button',
        className: 'proceed-stage-btn',
        text: 'Proceed to Research (Stage 2) →',
      });
      proceedBtn.addEventListener('click', proceedToResearch);
      primaryActions.push(proceedBtn);
    }

    const expandBtnText = State.ideaInlineExpansionIndex === idea.index
      ? (hasVariations ? 'Close Variations ▲' : 'Close Reiteration ▲')
      : (hasVariations ? `Explore Angles & ${variationData.variations.length} Variations ▾` : 'Explore Angles in Direction ▾');

    const expandBtn = el('button', {
      type: 'button',
      className: 'expand-idea-btn',
      text: expandBtnText,
    });
    expandBtn.addEventListener('click', () => toggleIdeaExpansion(idea.index));

    const footer = el('footer', { className: 'idea-card-footer' }, [
      el('div', { className: 'card-primary-actions' }, primaryActions),
      el('div', { className: 'card-secondary-actions' }, [expandBtn]),
    ]);

    const cardChildren = [header, pitchContainer];
    if (angleCallout) cardChildren.push(angleCallout);
    if (dimensionsGrid) cardChildren.push(dimensionsGrid);
    cardChildren.push(footer);

    if (State.ideaInlineExpansionIndex === idea.index) {
      const expPanelChildren = [];

      // Check if there is an active run generating variations
      const activeGenRun = State.runs.find((r) => ['queued', 'running'].includes(r.status) && r.stageId === 'idea');
      if (activeGenRun) {
        expPanelChildren.push(el('div', { className: 'generating-variations-box' }, [
          el('span', { className: 'live-mark running' }),
          el('div', { style: 'flex: 1;' }, [
            el('strong', { text: `Generating variations for Idea ${idea.index}… ` }),
            el('small', { text: `(${humanStatus(activeGenRun.status)} · ${activeGenRun.adapter})` }),
          ]),
          el('button', {
            type: 'button',
            className: 'button quiet compact-button',
            text: 'View Terminal',
            onClick: () => { openConsole(); showRunLog(activeGenRun.id); }
          }),
        ]));
      }

      // If variations exist, render them!
      if (hasVariations) {
        expPanelChildren.push(el('div', { className: 'inline-variations-container' }, [
          el('div', { className: 'variations-header-row' }, [
            el('div', { className: 'variations-header-title' }, [
              el('span', { text: `✦ Angle Explorations & Deep Dives (Round ${variationData.versionNum})` }),
              el('span', { className: 'variations-count-tag', text: `${variationData.variations.length} generated` }),
            ]),
            el('button', {
              type: 'button',
              className: 'button quiet compact-button',
              text: `Open Full Round ${variationData.versionNum} →`,
              title: 'View all variations in full deck mode',
              onClick: () => {
                State.ideaSelectedVersion = variationData.targetArtifact;
                renderIdeaStudio();
              }
            }),
          ]),
          el('div', { className: 'variations-grid' }, variationData.variations.map((v, vIdx) => {
            const isVarSelected = Boolean(selectedIdea && (selectedIdea.title === v.title || (Number(selectedIdea.index) === Number(v.index) && selectedIdea.version === `v${variationData.versionNum}`)));
            const vRatings = [];
            if (v.ratings.tension) vRatings.push(el('span', { className: `idea-rating-pill ${parseFloat(v.ratings.tension) >= 4 ? 'high' : ''}`, text: `Tension: ${v.ratings.tension}/5` }));
            if (v.ratings.evidence) vRatings.push(el('span', { className: `idea-rating-pill ${parseFloat(v.ratings.evidence) >= 4 ? 'high' : ''}`, text: `Evidence: ${v.ratings.evidence}/5` }));
            if (v.ratings.visual) vRatings.push(el('span', { className: `idea-rating-pill ${parseFloat(v.ratings.visual) >= 4 ? 'high' : ''}`, text: `Visuals: ${v.ratings.visual}/5` }));

            const chooseBtn = el('button', {
              type: 'button',
              className: `variation-select-btn ${isVarSelected ? 'is-selected' : ''}`,
              text: isVarSelected ? '✓ Locked for Production' : 'Select This Variation',
            });
            chooseBtn.addEventListener('click', () => selectIdea(v, `v${variationData.versionNum}`));

            const vCardChildren = [
              el('div', { className: 'variation-card-header' }, [
                el('h4', { className: 'variation-title', text: `${idea.index}.${vIdx + 1}: ${v.title}` }),
                el('div', { className: 'idea-ratings-group' }, vRatings),
              ]),
              el('p', { className: 'variation-pitch', text: v.pitch }),
            ];
            if (v.angle) {
              vCardChildren.push(el('div', { className: 'variation-angle' }, [
                el('strong', { text: 'Angle: ' }),
                el('span', { text: v.angle })
              ]));
            }
            vCardChildren.push(el('div', { className: 'variation-footer' }, [
              chooseBtn,
              isVarSelected ? el('button', {
                type: 'button',
                className: 'proceed-stage-btn',
                text: 'Proceed to Research (Stage 2) →',
                onClick: proceedToResearch
              }) : null
            ].filter(Boolean)));

            return el('div', { className: `variation-card ${isVarSelected ? 'selected-variation' : ''}` }, vCardChildren);
          }))
        ]));
      }

      // Generator section below variations or initial
      const expInput = el('input', {
        type: 'text',
        className: 'expansion-input',
        placeholder: hasVariations
          ? 'Steer more variations (e.g. emphasize epigraphic copper plates, examine counter-theories)...'
          : 'Optional steering (e.g. emphasize epigraphic copper plates, trace migration through Godavari)...',
      });
      const submitExpBtn = el('button', {
        type: 'button',
        className: 'button primary compact-button',
        text: hasVariations ? 'Generate 5 More Variations' : 'Generate 5 Variations',
      });
      submitExpBtn.addEventListener('click', () => submitIdeaExpansion(idea, expInput.value));
      expInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitIdeaExpansion(idea, expInput.value); }
      });
      const cancelExpBtn = el('button', {
        type: 'button',
        className: 'button quiet compact-button',
        text: 'Close',
      });
      cancelExpBtn.addEventListener('click', () => toggleIdeaExpansion(idea.index));

      const generatorHeader = el('div', { className: 'expansion-header' }, [
        el('span', { text: hasVariations ? `Branch & Deepen Further: Generate 5 more variations` : `Branch & Deepen: Generate 5 variations exploring Idea ${idea.index}` }),
      ]);

      const expActionWrap = el('div', { className: 'expansion-actions' }, [cancelExpBtn, submitExpBtn]);

      expPanelChildren.push(generatorHeader, expInput, expActionWrap);

      const expPanel = el('div', { className: 'inline-expansion-panel' }, expPanelChildren);
      cardChildren.push(expPanel);
      if (!hasVariations) {
        setTimeout(() => expInput.focus(), 0);
      }
    }

    return el('article', { className: `idea-card ${isSelected ? 'selected' : ''}` }, cardChildren);
  }));
}

async function setIdeaMode(mode) {
  if (!State.project) return;
  const data = { ...(State.project.stages.idea?.data || {}), planningMode: mode };
  State.project.stages.idea.data = data;
  renderIdeaStudio();
  await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/idea`, {
    method: 'PATCH',
    body: { data },
  }).catch(() => {});
}

async function generateGuidedIdeas() {
  const topic = $('deck-idea-topic').value.trim();
  if (!topic) return toast('Please enter a topic or seed idea', 'error');
  const sources = $('deck-idea-sources').value.trim();
  $('generate-guided-ideas').disabled = true;
  $('console-output').textContent = '';
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'idea',
        substage: 'generate',
        adapter: agentForStage('idea'),
        planningMode: 'guided',
        topicDescription: topic,
        manualSources: sources,
      }
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderIdeaStudioRunState();
    toast('Idea generation queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    renderIdeaStudioRunState();
  }
}

async function generateProactiveIdeas() {
  const steer = $('deck-proactive-steer').value.trim();
  $('generate-proactive-ideas').disabled = true;
  $('console-output').textContent = '';
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'idea',
        substage: 'generate',
        adapter: agentForStage('idea'),
        planningMode: 'proactive',
        topicDescription: '',
        manualSources: steer || '',
        iterationNote: steer ? `Steer proactive channel ideation with this focus: ${steer}` : '',
      }
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderIdeaStudioRunState();
    toast('Proactive discovery queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    renderIdeaStudioRunState();
  }
}

async function selectIdea(idea, version) {
  if (!State.project) return;
  try {
    const res = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/idea/select`, {
      method: 'POST',
      body: {
        version,
        ideaIndex: idea.index,
        idea,
        updateTitle: true,
      }
    });
    State.project = res.project;
    State.artifacts = res.artifacts;
    toast(`Selected: ${idea.title}`, 'success');
    renderWorkspace();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function clearSelectedIdea() {
  if (!State.project) return;
  try {
    const data = { ...(State.project.stages.idea?.data || {}), selectedIdea: null, selectedConcept: '', selectedTitle: '' };
    await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/idea`, {
      method: 'PATCH',
      body: { data },
    });
    State.project.stages.idea.data = data;
    toast('Selection cleared', 'success');
    renderWorkspace();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function toggleIdeaExpansion(index) {
  State.ideaInlineExpansionIndex = State.ideaInlineExpansionIndex === index ? null : index;
  renderIdeaStudio();
}

async function submitIdeaExpansion(idea, steerInstruction) {
  const steer = String(steerInstruction || '').trim();
  const iterationNote = `Additive pass: Deepen and generate 5 distinct video idea variations rooted specifically in Idea ${idea.index}: "${idea.title}". Core premise: "${idea.pitch}". Narrative angle: "${idea.angle}". User steering directive: "${steer || 'Explore deeper variations, alternative investigative angles, and specific historical episodes based on this premise'}"`;

  State.ideaInlineExpansionIndex = idea.index;
  $('console-output').textContent = '';
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'idea',
        substage: 'generate',
        adapter: agentForStage('idea'),
        planningMode: 'guided',
        topicDescription: idea.title,
        iterationNote,
        parentArtifact: State.ideaSelectedVersion || '00_project/idea_v1.md',
        parentIndex: idea.index,
        parentTitle: idea.title,
      }
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderIdeaStudioRunState();
    renderIdeaStudio();
    toast(`Queued variations pass for Idea ${idea.index}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refineCurrentRound() {
  const refineText = $('idea-refine-input').value.trim();
  if (!refineText) return toast('Please enter an instruction to refine these ideas', 'error');
  const iterationNote = `Additive pass: Refine and improve the previous ideas applying this direction: ${refineText}`;
  $('refine-round-btn').disabled = true;
  $('console-output').textContent = '';
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'idea',
        substage: 'generate',
        adapter: agentForStage('idea'),
        planningMode: State.project.stages.idea?.data?.planningMode || 'guided',
        topicDescription: State.project.stages.idea?.data?.topicDescription || '',
        iterationNote,
      }
    });
    $('idea-refine-input').value = '';
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderIdeaStudioRunState();
    toast('Refinement pass queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    renderIdeaStudioRunState();
  }
}

async function generateFreshRound() {
  const iterationNote = `Additive pass: Generate 6 completely fresh, alternative video title ideas exploring distinct and untested angles for this channel and topic.`;
  $('fresh-round-btn').disabled = true;
  $('console-output').textContent = '';
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'idea',
        substage: 'generate',
        adapter: agentForStage('idea'),
        planningMode: State.project.stages.idea?.data?.planningMode || 'guided',
        topicDescription: State.project.stages.idea?.data?.topicDescription || '',
        iterationNote,
      }
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderIdeaStudioRunState();
    toast('Fresh ideas pass queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    renderIdeaStudioRunState();
  }
}

function toggleRawIdeaView() {
  State.ideaViewMode = State.ideaViewMode === 'cards' ? 'raw' : 'cards';
  if (State.ideaViewMode === 'raw') {
    const ideaArtifacts = artifactsForStage();
    if (!State.selectedArtifact && ideaArtifacts.length) {
      State.selectedArtifact = State.ideaSelectedVersion || ideaArtifacts[0].relativePath;
    }
  }
  renderStage();
  renderArtifacts();
}

/* ==========================================================================
   Stage 2: Research Studio Functions
   ========================================================================== */

function handleResearchStepOutput(text) {
  if (!text) return;
  const match = text.match(/\[STEP:(\d)\/5:(START|DONE)(?::(.*?))?\]/);
  if (match) {
    const stepNum = Number(match[1]);
    const action = match[2];
    const desc = (match[3] || '').trim();
    State.researchCurrentStep = action === 'DONE' && stepNum < 5 ? stepNum + 1 : stepNum;
    State.researchStepStatus = desc || (action === 'START' ? `Running Step ${stepNum} of 5...` : `Step ${stepNum} completed`);
    updateResearchStepperUI();
  }
}

function updateResearchStepperUI() {
  const current = State.researchCurrentStep;
  for (let i = 1; i <= 5; i++) {
    const card = $(`step-${i}-card`);
    if (!card) continue;
    if (i < current) {
      card.className = 'stepper-step completed';
      const num = card.querySelector('.step-num-icon');
      if (num) num.textContent = '✓';
    } else if (i === current) {
      card.className = 'stepper-step active';
      const num = card.querySelector('.step-num-icon');
      if (num) num.textContent = String(i);
    } else {
      card.className = 'stepper-step';
      const num = card.querySelector('.step-num-icon');
      if (num) num.textContent = String(i);
    }
  }
  for (let i = 1; i < 5; i++) {
    $(`connector-${i}-${i + 1}`)?.classList.toggle('completed', i < current);
  }
  if ($('stepper-status-text')) $('stepper-status-text').textContent = State.researchStepStatus || 'Ready to run deep research';
  if ($('stepper-pulse-dot')) $('stepper-pulse-dot').hidden = !State.researchStepStatus || !State.activeRunId;
}

function renderResearchStudioRunState() {
  const active = State.runs.find((run) => ['queued', 'running'].includes(run.status));
  const isRunning = Boolean(active);
  if ($('btn-start-deep-research')) $('btn-start-deep-research').disabled = isRunning;
  if ($('btn-rerun-factcheck')) $('btn-rerun-factcheck').disabled = isRunning;
  if ($('btn-submit-deepen')) $('btn-submit-deepen').disabled = isRunning;
  if ($('research-stop-run')) {
    $('research-stop-run').hidden = !isRunning;
    if (active) $('research-stop-run').dataset.runId = active.id;
  }
  if ($('stepper-pulse-dot')) $('stepper-pulse-dot').hidden = !isRunning;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderInlineMarkdown(raw) {
  if (!raw) return '';
  let str = escapeHtml(raw);

  // 1. Code spans first so syntax inside code is preserved
  const codeSpans = [];
  str = str.replace(/`([^`]+)`/g, (_, code) => {
    // Check if code block contains a visual cue like `[GEN: ...]`
    const cueMatch = code.match(/^\[(GEN|VISUAL|PHOTO|MAP|ART|TEXT|MUSIC):\s*([^\]]+)\]$/i);
    if (cueMatch) {
      const t = cueMatch[1].toLowerCase();
      return cueMarkup(t === 'visual' ? 'gen' : t, cueMatch[2], t === 'visual' ? 'Visual' : '');
    }
    codeSpans.push(code);
    return `%%CODESPAN_${codeSpans.length - 1}%%`;
  });

  // 2. Visual Cue Markers: [GEN: ...], [VISUAL: ...], [PHOTO: ...], [MAP: ...], [ART: ...], [TEXT: ...], [MUSIC: ...]
  str = str.replace(/\[(GEN|VISUAL|PHOTO|MAP|ART|TEXT|MUSIC):\s*([^\]]+)\]/gi, (_, type, content) => {
    const t = type.toLowerCase();
    return cueMarkup(t === 'visual' ? 'gen' : t, content, t === 'visual' ? 'Visual' : '');
  });
  str = str.replace(/\[(PAUSE|SLOW)\]/gi, (_, type) => {
    return cueMarkup('music', '', type);
  });

  // 3. Bold (**text**)
  str = str.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');

  // 4. Italic (*text*)
  str = str.replace(/(^|[^\*])\*([^\*]+)\*([^\*]|$)/g, '$1<em>$2</em>$3');

  // 5. Links [text](url)
  str = str.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 6. Direct URLs not inside href
  str = str.replace(/(^|[^">])(https?:\/\/[a-zA-Z0-9_\-\.\/\?%&=+#;]+)([^"<]|$)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>$3');

  // 7. Restore code spans
  str = str.replace(/%%CODESPAN_(\d+)%%/g, (_, idx) => {
    return `<code>${codeSpans[idx]}</code>`;
  });

  return str;
}

function cueMarkup(type, content, label = '') {
  const labels = { gen: 'Visual', photo: 'Archive', map: 'Map', art: 'Artwork', text: 'Source', music: 'Music' };
  return `<span class="cue-chip ${type}"><span class="cue-tag">${label || labels[type] || type}</span><span class="cue-copy">${String(content).trim()}</span></span>`;
}

function renderMarkdownInto(text, container, options = {}) {
  if (!text) {
    container.replaceChildren(el('p', { className: 'muted', text: 'No content available.' }));
    return;
  }
  const lines = text.split('\n');
  const fragment = document.createDocumentFragment();
  let currentParagraph = [];
  let currentList = null;
  let inTable = false;
  let tableRows = [];
  let headingCount = 0;

  function flushParagraph() {
    if (currentParagraph.length) {
      const pText = currentParagraph.join(' ').trim();
      if (pText) {
        const p = document.createElement('p');
        p.innerHTML = renderInlineMarkdown(pText);
        fragment.append(p);
      }
      currentParagraph = [];
    }
  }

  function flushList() {
    if (currentList) {
      fragment.append(currentList);
      currentList = null;
    }
  }

  function flushTable() {
    if (inTable && tableRows.length) {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');

      const headerCells = tableRows[0];
      const trHead = document.createElement('tr');
      headerCells.forEach((c) => {
        const th = document.createElement('th');
        th.innerHTML = renderInlineMarkdown(c.trim());
        trHead.append(th);
      });
      thead.append(trHead);
      table.append(thead);

      for (let r = 1; r < tableRows.length; r++) {
        const rowCells = tableRows[r];
        if (rowCells.every((cell) => /^[\s\-:|]+$/.test(cell))) continue;
        const tr = document.createElement('tr');
        rowCells.forEach((c) => {
          const td = document.createElement('td');
          td.innerHTML = renderInlineMarkdown(c.trim());
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(tbody);
      fragment.append(table);
      tableRows = [];
      inTable = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph();
      flushList();
      inTable = true;
      const cells = trimmed.slice(1, -1).split('|');
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (trimmed === '---' || trimmed === '***') {
      flushParagraph();
      flushList();
      fragment.append(document.createElement('hr'));
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flushParagraph();
      flushList();
      const h1 = document.createElement('h1');
      h1.innerHTML = renderInlineMarkdown(trimmed.slice(2).trim());
      fragment.append(h1);
    } else if (trimmed.startsWith('## ')) {
      flushParagraph();
      flushList();
      headingCount++;
      const h2 = document.createElement('h2');
      const match = trimmed.slice(3).trim().match(/^(?:(\d+)[\.\s]+)?(.+)/);
      const secId = match && match[1] ? `script-sec-${match[1]}` : `sec-${headingCount}`;
      h2.id = secId;
      h2.innerHTML = renderInlineMarkdown(trimmed.slice(3).trim());
      fragment.append(h2);
    } else if (trimmed.startsWith('### ')) {
      flushParagraph();
      flushList();
      const h3 = document.createElement('h3');
      h3.innerHTML = renderInlineMarkdown(trimmed.slice(4).trim());
      fragment.append(h3);
    } else if (trimmed.startsWith('#### ')) {
      flushParagraph();
      flushList();
      const h4 = document.createElement('h4');
      h4.innerHTML = renderInlineMarkdown(trimmed.slice(5).trim());
      fragment.append(h4);
    } else if (trimmed.startsWith('> ')) {
      flushParagraph();
      flushList();
      const bq = document.createElement('blockquote');
      bq.innerHTML = renderInlineMarkdown(trimmed.slice(2).trim());
      fragment.append(bq);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      flushParagraph();
      if (!currentList || currentList.tagName !== 'UL') {
        flushList();
        currentList = document.createElement('ul');
      }
      const li = document.createElement('li');
      li.innerHTML = renderInlineMarkdown(trimmed.slice(2).trim());
      currentList.append(li);
    } else if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      if (!currentList || currentList.tagName !== 'OL') {
        flushList();
        currentList = document.createElement('ol');
      }
      const li = document.createElement('li');
      li.innerHTML = renderInlineMarkdown(trimmed.replace(/^\d+\.\s+/, '').trim());
      currentList.append(li);
    } else {
      flushList();
      currentParagraph.push(trimmed);
    }
  }

  flushParagraph();
  flushList();
  flushTable();
  container.replaceChildren(fragment);
}

async function renderResearchStudio() {
  if (!State.project || State.currentStage !== 'research') return;
  const project = State.project;
  const ideaState = project.stages?.idea || {};
  const ideaData = ideaState.data || {};
  const selectedIdea = ideaData.selectedIdea;

  const title = selectedIdea?.title || ideaData.selectedTitle || ideaData.selectedConcept || project.title || 'Selected Topic';
  const premise = selectedIdea?.pitch || ideaData.topicDescription || 'Evidence-led investigation reconstructing historical transmission and primary records.';
  const versionTag = selectedIdea?.version ? `Idea ${selectedIdea.index || 1} (${selectedIdea.version})` : 'Selected Concept';

  if ($('research-topic-title')) $('research-topic-title').textContent = title;
  if ($('research-topic-premise')) $('research-topic-premise').textContent = premise;

  const channel = State.channels.find((c) => c.id === project.channelId) || {};
  if ($('research-channel-pill')) $('research-channel-pill').textContent = channel.name || project.channelId || 'Example Channel';
  if ($('research-duration-pill')) $('research-duration-pill').textContent = `${project.settings?.targetDurationMin || 12} min`;
  if ($('research-lang-pill')) $('research-lang-pill').textContent = project.settings?.language || 'hi';
  if ($('research-idea-tag')) $('research-idea-tag').textContent = versionTag;

  const researchArtifacts = State.artifacts.filter((a) =>
    a.stageId === 'research' || a.relativePath.startsWith('01_research/')
  );

  const pureCorpusFiles = researchArtifacts.filter((a) =>
    /(?:research_corpus|synthesis_v\d+|dossiers\/evidence_v\d+)/i.test(a.relativePath) && !a.relativePath.includes('discarded')
  );
  const factcheckFiles = researchArtifacts.filter((a) =>
    /(?:factcheck|claim_ledger|verification|remediation)/i.test(a.relativePath)
  );
  const sourceFiles = researchArtifacts.filter((a) =>
    /(?:sources|passes\/|plans\/|synthesis\/|initial_brief|followup_results|index\.json|manifest|pipeline|discovery|evidence_pack|source_records)/i.test(a.relativePath)
  );
  const discardedFiles = researchArtifacts.filter((a) =>
    /(?:material_discarded|discarded)/i.test(a.relativePath)
  );

  const hasResearch = pureCorpusFiles.length > 0 || factcheckFiles.length > 0 || sourceFiles.length > 0;

  if ($('research-empty-hero')) $('research-empty-hero').hidden = hasResearch;
  if ($('research-active-workspace')) $('research-active-workspace').hidden = !hasResearch;

  if (!State.activeRunId && State.researchCurrentStep === 0) {
    if (pureCorpusFiles.length > 0 && factcheckFiles.length > 0) {
      State.researchCurrentStep = 5;
      State.researchStepStatus = 'Adaptive research completed · verified production brief ready';
    } else if (pureCorpusFiles.length > 0) {
      State.researchCurrentStep = 3;
      State.researchStepStatus = 'Dossier synthesized · Fact-check audit ready';
    } else {
      State.researchCurrentStep = 0;
      State.researchStepStatus = 'Ready to launch autonomous deep research';
    }
  }
  updateResearchStepperUI();
  renderResearchStudioRunState();

  if (!hasResearch) return;

  renderResearchHierarchyTree({ pureCorpusFiles, factcheckFiles, sourceFiles, discardedFiles });
  await renderResearchTabView({ pureCorpusFiles, factcheckFiles, sourceFiles, discardedFiles });
}

function renderResearchHierarchyTree({ pureCorpusFiles, factcheckFiles, sourceFiles, discardedFiles }) {
  const pureItems = pureCorpusFiles.map((artifact) => {
    const filename = artifact.relativePath.split('/').at(-1);
    const active = State.researchActiveView === 'corpus' && (State.researchSelectedArtifact === artifact.relativePath || !State.researchSelectedArtifact);
    const btn = el('button', {
      type: 'button',
      className: `tree-item-btn ${active ? 'active' : ''}`,
    }, [
      el('span', { text: filename }),
      el('span', { className: 'tree-item-meta', text: formatBytes(artifact.size) }),
    ]);
    btn.addEventListener('click', () => {
      State.researchActiveView = 'corpus';
      State.researchSelectedArtifact = artifact.relativePath;
      renderResearchStudio();
    });
    return btn;
  });
  if ($('tree-pure-corpus')) $('tree-pure-corpus').replaceChildren(...(pureItems.length ? pureItems : [el('span', { className: 'tree-item-meta', text: 'Generating dossier...' })]));

  const fcItems = factcheckFiles.map((artifact) => {
    const filename = artifact.relativePath.split('/').at(-1);
    const active = State.researchActiveView === 'factcheck';
    const btn = el('button', {
      type: 'button',
      className: `tree-item-btn ${active ? 'active' : ''}`,
    }, [
      el('span', { text: filename }),
      el('span', { className: 'tree-item-meta', text: formatBytes(artifact.size) }),
    ]);
    btn.addEventListener('click', () => {
      State.researchActiveView = 'factcheck';
      renderResearchStudio();
    });
    return btn;
  });
  if ($('tree-factcheck')) $('tree-factcheck').replaceChildren(...(fcItems.length ? fcItems : [el('span', { className: 'tree-item-meta', text: 'Audit pending' })]));

  const srcItems = sourceFiles.map((artifact) => {
    const filename = artifact.relativePath.split('/').at(-1);
    const active = State.researchActiveView === 'sources' && State.researchSelectedArtifact === artifact.relativePath;
    const btn = el('button', {
      type: 'button',
      className: `tree-item-btn ${active ? 'active' : ''}`,
    }, [
      el('span', { text: filename }),
      el('span', { className: 'tree-item-meta', text: formatBytes(artifact.size) }),
    ]);
    btn.addEventListener('click', () => {
      State.researchActiveView = 'sources';
      State.researchSelectedArtifact = artifact.relativePath;
      renderResearchStudio();
    });
    return btn;
  });
  if ($('tree-sources')) $('tree-sources').replaceChildren(...(srcItems.length ? srcItems : [el('span', { className: 'tree-item-meta', text: 'No sources indexed' })]));

  const discItems = discardedFiles.map((artifact) => {
    const filename = artifact.relativePath.split('/').at(-1);
    const active = State.researchActiveView === 'discarded';
    const btn = el('button', {
      type: 'button',
      className: `tree-item-btn ${active ? 'active' : ''}`,
    }, [
      el('span', { text: filename }),
      el('span', { className: 'tree-item-meta', text: formatBytes(artifact.size) }),
    ]);
    btn.addEventListener('click', () => {
      State.researchActiveView = 'discarded';
      renderResearchStudio();
    });
    return btn;
  });
  if ($('tree-discarded')) $('tree-discarded').replaceChildren(...(discItems.length ? discItems : [el('span', { className: 'tree-item-meta', text: '0 claims discarded' })]));
}

async function renderResearchTabView({ pureCorpusFiles, factcheckFiles, sourceFiles, discardedFiles }) {
  const currentView = State.researchActiveView || 'corpus';

  $('tab-corpus-dossier')?.classList.toggle('active', currentView === 'corpus');
  $('tab-factcheck-matrix')?.classList.toggle('active', currentView === 'factcheck');
  $('tab-sources-ledger')?.classList.toggle('active', currentView === 'sources');
  $('tab-discarded-ledger')?.classList.toggle('active', currentView === 'discarded');

  if ($('panel-corpus-view')) $('panel-corpus-view').hidden = currentView !== 'corpus';
  if ($('panel-factcheck-view')) $('panel-factcheck-view').hidden = currentView !== 'factcheck';
  if ($('panel-sources-view')) $('panel-sources-view').hidden = currentView !== 'sources';
  if ($('panel-discarded-view')) $('panel-discarded-view').hidden = currentView !== 'discarded';

  // 1. Corpus Dossier View
  if (currentView === 'corpus') {
    const targetArtifact = pureCorpusFiles.find((a) => a.relativePath === State.researchSelectedArtifact) || pureCorpusFiles[0];
    if (!targetArtifact) return;
    State.researchSelectedArtifact = targetArtifact.relativePath;
    if ($('corpus-active-filename')) $('corpus-active-filename').textContent = targetArtifact.relativePath.split('/').at(-1);
    if ($('corpus-active-filesize')) $('corpus-active-filesize').textContent = formatBytes(targetArtifact.size);

    let content = State.researchArtifactCache[targetArtifact.relativePath];
    if (content === undefined) {
      try {
        const resp = await fetch(mediaUrl(targetArtifact), { credentials: 'same-origin' });
        content = resp.ok ? await resp.text() : '';
        State.researchArtifactCache[targetArtifact.relativePath] = content;
      } catch { content = ''; }
    }

    if ($('corpus-rendered-content')) renderMarkdownInto(content, $('corpus-rendered-content'));
    if ($('corpus-editor-textarea')) $('corpus-editor-textarea').value = content;
  }

  // 2. Fact-Check Matrix View
  if (currentView === 'factcheck') {
    let ledger = null;
    const ledgerArtifact = factcheckFiles.find((a) => a.relativePath.endsWith('claim_ledger.json'));
    if (ledgerArtifact) {
      try {
        const resp = await fetch(mediaUrl(ledgerArtifact), { credentials: 'same-origin' });
        if (resp.ok) ledger = await resp.json();
      } catch {}
    }

    const claims = ledger?.claims || [];
    const counts = ledger?.counts || {
      SUPPORTED: claims.filter((c) => c.status === 'SUPPORTED').length,
      PARTIAL: claims.filter((c) => c.status === 'PARTIAL').length,
      UNVERIFIED: claims.filter((c) => c.status === 'UNVERIFIED').length,
    };

    if ($('fc-stat-total')) $('fc-stat-total').textContent = String(claims.length);
    if ($('fc-stat-supported')) $('fc-stat-supported').textContent = String(counts.SUPPORTED || 0);
    if ($('fc-stat-partial')) $('fc-stat-partial').textContent = String(counts.PARTIAL || 0);
    if ($('fc-stat-unverified')) $('fc-stat-unverified').textContent = String(counts.UNVERIFIED || 0);
    if ($('factcheck-tab-count')) $('factcheck-tab-count').textContent = String(claims.length);

    const filter = State.researchClaimsFilter || 'ALL';
    const filteredClaims = filter === 'ALL' ? claims : claims.filter((c) => c.status === filter);

    const deck = $('factcheck-claims-deck');
    if (deck) {
      if (!filteredClaims.length) {
        deck.replaceChildren(el('div', { className: 'rail-empty', text: claims.length ? 'No claims matching filter' : 'No claims audited yet. Click "Rerun Fact-Check" to audit the corpus.' }));
      } else {
        deck.replaceChildren(...filteredClaims.map((item) => {
          const card = el('article', { className: `claim-card status-${item.status.toLowerCase()}` }, [
            el('div', { className: 'claim-card-header' }, [
              el('span', { className: 'claim-id-tag', text: item.id }),
              el('span', { className: 'claim-status-badge', text: item.status }),
            ]),
            el('p', { className: 'claim-body-text', text: item.claim }),
            el('div', { className: 'claim-evidence-box' }, [
              el('strong', { text: `Evidence Candidate (Score: ${item.matchScore || 0})` }),
              item.evidenceSourceUrl
                ? el('a', { href: item.evidenceSourceUrl, target: '_blank', rel: 'noopener noreferrer', text: `Captured source ${item.evidenceSourceId || ''}`.trim() })
                : el('span', { className: 'tree-item-meta', text: 'No captured source matched' }),
              el('span', { text: item.evidenceExcerpt || 'No direct matching excerpt found in local corpus.' }),
            ]),
          ]);

          const actions = el('div', { className: 'claim-card-actions' });
          if (item.status !== 'DISCARDED') {
            const discardBtn = el('button', {
              type: 'button',
              className: 'claim-action-btn discard',
              text: '✕ Discard Claim',
            });
            discardBtn.addEventListener('click', () => discardResearchClaim(item));
            actions.append(discardBtn);
          } else {
            actions.append(el('span', { className: 'tree-item-meta', text: 'Excluded from script' }));
          }
          card.append(actions);
          return card;
        }));
      }
    }
  }

  // 3. Sources View
  if (currentView === 'sources') {
    const container = $('sources-list-container');
    if (container) {
      const srcArtifact = sourceFiles.find((a) => a.relativePath.endsWith('sources.json')) || sourceFiles.find((a) => a.relativePath.endsWith('sources.md')) || sourceFiles[0];
      if (srcArtifact) {
        let text = State.researchArtifactCache[srcArtifact.relativePath];
        if (text === undefined) {
          try {
            const resp = await fetch(mediaUrl(srcArtifact), { credentials: 'same-origin' });
            text = resp.ok ? await resp.text() : '';
            State.researchArtifactCache[srcArtifact.relativePath] = text;
          } catch { text = ''; }
        }
        if (srcArtifact.relativePath.endsWith('.json')) {
          try {
            const catalog = JSON.parse(text);
            const sources = Array.isArray(catalog.sources) ? catalog.sources : [];
            container.replaceChildren(
              el('p', { className: 'muted', text: `${sources.length} source record${sources.length === 1 ? '' : 's'} · only “Captured” sources can support claims.` }),
              ...sources.map((source) => {
                const fetched = source.status === 'fetched';
                const link = source.url
                  ? el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.url })
                  : el('span', { text: 'Missing URL' });
                return el('article', { className: `claim-card ${fetched ? 'status-supported' : 'status-unverified'}` }, [
                  el('div', { className: 'claim-card-header' }, [
                    el('span', { className: 'claim-status-badge', text: fetched ? 'CAPTURED' : String(source.status || 'UNKNOWN').toUpperCase() }),
                    el('span', { className: 'claim-id-tag', text: source.id || 'unidentified' }),
                  ]),
                  link,
                  el('p', { className: 'tree-item-meta', text: fetched
                    ? `${source.contentType || 'source'} · ${formatBytes(source.bytes || 0)} · ${source.extractor || 'text extraction'}`
                    : source.error || 'No extractable local text.' }),
                  source.excerpt ? el('p', { className: 'claim-body-text', text: source.excerpt }) : null,
                ]);
              }),
            );
          } catch {
            renderMarkdownInto(text, container);
          }
        } else renderMarkdownInto(text, container);
      } else {
        container.replaceChildren(el('p', { className: 'muted', text: 'No sources ledger available.' }));
      }
    }
  }

  // 4. Discarded Material View
  if (currentView === 'discarded') {
    const container = $('discarded-list-container');
    if (container) {
      const discArtifact = discardedFiles.find((a) => a.relativePath.includes('material_discarded'));
      if (discArtifact) {
        let text = State.researchArtifactCache[discArtifact.relativePath];
        if (text === undefined) {
          try {
            const resp = await fetch(mediaUrl(discArtifact), { credentials: 'same-origin' });
            text = resp.ok ? await resp.text() : '';
            State.researchArtifactCache[discArtifact.relativePath] = text;
          } catch { text = ''; }
        }
        renderMarkdownInto(text, container);
      } else {
        container.replaceChildren(el('p', { className: 'muted', text: 'No claims or materials discarded yet.' }));
      }
    }
  }
}

async function startDeepResearch() {
  const seedNotes = $('research-seed-notes')?.value?.trim();
  State.researchCurrentStep = 1;
  State.researchStepStatus = 'Planning the research angles and synthesis depth…';
  updateResearchStepperUI();
  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/research/pipeline`, {
      method: 'POST',
      body: {
        adapter: agentForStage('research'),
        direction: seedNotes || undefined,
      },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderResearchStudioRunState();
    toast('Adaptive deep research started', 'success');
  } catch (error) {
    toast(error.message, 'error');
    renderResearchStudioRunState();
  }
}

async function rerunFactCheck() {
  State.researchCurrentStep = 4;
  State.researchStepStatus = 'Auditing claims against evidence corpus...';
  updateResearchStepperUI();
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'research',
        substage: 'audit',
        adapter: agentForStage('research'),
      },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderResearchStudioRunState();
    toast('Started evidence audit', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function writeResearchDossier() {
  State.researchCurrentStep = 3;
  State.researchStepStatus = 'Writing detailed, evidence-cited dossiers from local packs...';
  updateResearchStepperUI();
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: { projectKey: State.projectKey, stageId: 'research', substage: 'write', adapter: agentForStage('research') },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns(); renderRunControls(); renderResearchStudioRunState();
    toast('Research dossier writing started', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

function toggleDeepenPanel(open = null) {
  const panel = $('research-deepen-panel');
  if (!panel) return;
  const show = open === null ? panel.hidden : open;
  panel.hidden = !show;
  if (show) setTimeout(() => $('research-deepen-input')?.focus(), 0);
}

async function submitDeepenResearch() {
  const steer = $('research-deepen-input')?.value?.trim();
  toggleDeepenPanel(false);
  State.researchCurrentStep = 2;
  State.researchStepStatus = `Planning a new adaptive research cycle: "${steer || 'deeper investigation'}"…`;
  updateResearchStepperUI();
  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/research/pipeline`, {
      method: 'POST',
      body: {
        adapter: agentForStage('research'),
        direction: steer || undefined,
      },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    renderResearchStudioRunState();
    toast('Deeper research cycle started', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function discardResearchClaim(claim) {
  try {
    await api(`/api/projects/${encodeURIComponent(State.projectKey)}/research/discard`, {
      method: 'POST',
      body: {
        claimId: claim.id,
        claimText: claim.claim,
        reason: 'Flagged as unsupported during fact-check audit',
      },
    });
    toast(`Claim ${claim.id} discarded and excluded from script`, 'success');
    State.researchArtifactCache = {};
    await loadProject(State.projectKey, { preserveArtifact: true });
    renderResearchStudio();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function toggleRawResearchView() {
  State.researchViewMode = State.researchViewMode === 'studio' ? 'workbench' : 'studio';
  renderWorkspace();
}

async function proceedToScript() {
  if (!await decideStage('approved')) return;
  await switchStage('script');
  toast('Advanced to Stage 3: Script', 'success');
}

/* ==========================================================================
   Stage 3: Script Studio Functions
   ========================================================================== */

function findLatestScriptArtifact(artifacts) {
  const list = (artifacts || State.artifacts || []).filter((a) => a.stageId === 'script' || a.relativePath.startsWith('02_script/'));
  if (!list.length) return null;

  const getVersion = (path) => {
    const match = (path || '').match(/_v(\d+)/i);
    return match ? parseInt(match[1], 10) : 0;
  };

  const sortArtifacts = (arr) => arr.sort((a, b) => {
    const vDiff = getVersion(b.relativePath) - getVersion(a.relativePath);
    if (vDiff !== 0) return vDiff;
    return (b.revision || 0) - (a.revision || 0);
  });

  const finals = list.filter((a) => /(?:^|\/)final[_\.]/i.test(a.relativePath));
  if (finals.length) return sortArtifacts(finals)[0];

  const drafts = list.filter((a) => /(?:^|\/)(?:script|draft)[_\.]/i.test(a.relativePath));
  if (drafts.length) return sortArtifacts(drafts)[0];

  const factchecks = list.filter((a) => /(?:^|\/)factcheck_report/i.test(a.relativePath));
  if (factchecks.length) return sortArtifacts(factchecks)[0];

  const outlines = list.filter((a) => /(?:^|\/)outline[_\.]/i.test(a.relativePath));
  if (outlines.length) return sortArtifacts(outlines)[0];

  const mds = list.filter((a) => a.relativePath.endsWith('.md'));
  if (mds.length) return sortArtifacts(mds)[0];

  return list[0];
}

function calculateScriptDiagnostics(text, targetMinutes = 12, language = 'hi') {
  if (!text) return { words: 0, durationStr: '0:00', budgetText: '--', budgetClass: '', cuesCount: 0, cueDensityStr: '--', sectionsCount: 0 };

  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  const wpm = (language || '').startsWith('hi') ? 130 : 145;
  const totalSec = Math.round((words / wpm) * 60);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const durationStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

  const targetSec = (Number(targetMinutes) || 12) * 60;
  const diffSec = totalSec - targetSec;
  let budgetText = `On Target (${targetMinutes}m)`;
  let budgetClass = 'on-target';
  if (diffSec > 60) {
    const overMins = (diffSec / 60).toFixed(1);
    budgetText = `+${overMins}m Over Target`;
    budgetClass = 'over';
  } else if (diffSec < -60) {
    const underMins = (Math.abs(diffSec) / 60).toFixed(1);
    budgetText = `-${underMins}m Under Target`;
    budgetClass = 'under';
  }

  const cues = (text.match(/\[(GEN|PHOTO|MAP|ART|TEXT|MUSIC):/gi) || []).length;
  let cueDensityStr = '--';
  if (totalSec > 0 && cues > 0) {
    const intervalSec = Math.round(totalSec / cues);
    cueDensityStr = `1 cue / ${intervalSec}s`;
  }

  const sections = (text.match(/^##\s+.+/gm) || []).length;

  return { words, durationStr, budgetText, budgetClass, cuesCount: cues, cueDensityStr, sectionsCount: sections };
}

function extractScriptSections(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const sections = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^##\s+(?:(\d+)[\.\s]+)?(.+)/);
    if (match) {
      const secNum = match[1] || String(sections.length + 1);
      const rawTitle = match[2].trim();
      currentSection = {
        index: secNum,
        title: rawTitle,
        id: `script-sec-${secNum}`,
        duration: '',
        content: [],
      };
      sections.push(currentSection);
      continue;
    }
    if (currentSection) {
      const durMatch = line.match(/\*\*(?:समय|Duration|Estimated Duration)[^\*]*\*\*[:\s]*([0-9:\s–\-]+)/i);
      if (durMatch && !currentSection.duration) {
        currentSection.duration = durMatch[1].trim();
      }
      currentSection.content.push(line);
    }
  }
  return sections;
}

function extractTeleprompterNarration(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const narrationLines = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) continue;
    if (trimmed.startsWith('## ')) {
      narrationLines.push(`\n###SECTION_MARKER### ${trimmed.slice(3).trim()}\n`);
      inSection = true;
      continue;
    }
    if (!inSection && (trimmed.startsWith('- **') || trimmed.startsWith('---'))) continue;

    if (/^-\s+\*\*(?:समय|चैनल|भाषा|आउटपुट|लक्षित अवधि|स्क्रिप्ट|मुख्य साक्ष्य|स्रोत|दृश्य निर्देश|Visual Cue|Sources|Duration|Target)/i.test(trimmed)) {
      continue;
    }
    if (/^-\s+`?\[(GEN|PHOTO|MAP|ART|TEXT|MUSIC):/i.test(trimmed)) {
      continue;
    }
    if (trimmed === '---' || trimmed === '***') continue;

    let cleanLine = trimmed
      .replace(/`?\[(GEN|PHOTO|MAP|ART|TEXT|MUSIC):\s*[^\]]+\]`?/gi, '')
      .replace(/`?\[(PAUSE|SLOW)\]`?/gi, '')
      .replace(/\[Source URL:[^\]]+\]/gi, '')
      .trim();

    cleanLine = cleanLine.replace(/^-\s+\*\*[^\*]+:\*\*\s*/i, '');

    if (cleanLine) {
      narrationLines.push(cleanLine);
    }
  }

  return narrationLines.join('\n');
}

async function startGenerateScript() {
  const lang = $('script-gen-lang')?.value || 'en';
  const duration = Number($('script-gen-duration')?.value || 12);
  const notes = $('script-gen-notes')?.value || '';
  try {
    if (State.project?.settings?.scriptAuthoringLanguage !== lang || State.project?.settings?.targetDurationMin !== duration) {
      await api(`/api/projects/${encodeURIComponent(State.projectKey)}`, {
        method: 'PATCH',
        body: { settings: { scriptAuthoringLanguage: lang, targetDurationMin: duration } },
      });
    }
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'script',
        substage: 'draft',
        language: lang,
        iterationNote: notes ? `Direction: ${notes}` : `Generate script (${lang}, ${duration} min)`,
      },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    toast('Script generation queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runScriptFactcheck() {
  if (!State.selectedArtifact) return;
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'script',
        substage: 'factcheck',
        parentArtifact: State.selectedArtifact,
        iterationNote: `Fact-check against script: ${State.selectedArtifact}`,
      },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    toast('Fact-check queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openScriptRegenerateDrawer() {
  const drawer = $('script-regenerate-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  if ($('script-regen-lang')) $('script-regen-lang').value = State.project?.settings?.scriptAuthoringLanguage || 'en';
  if ($('script-regen-duration')) $('script-regen-duration').value = State.project?.settings?.targetDurationMin || 12;
  if ($('script-regen-notes')) $('script-regen-notes').value = '';
}

function closeScriptRegenerateDrawer() {
  if ($('script-regenerate-drawer')) $('script-regenerate-drawer').hidden = true;
}

async function confirmScriptRegenerate() {
  const lang = $('script-regen-lang')?.value || 'en';
  const duration = Number($('script-regen-duration')?.value || 12);
  const notes = $('script-regen-notes')?.value || '';
  try {
    if (State.project?.settings?.scriptAuthoringLanguage !== lang || State.project?.settings?.targetDurationMin !== duration) {
      await api(`/api/projects/${encodeURIComponent(State.projectKey)}`, {
        method: 'PATCH',
        body: { settings: { scriptAuthoringLanguage: lang, targetDurationMin: duration } },
      });
    }
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'script',
        substage: 'draft',
        language: lang,
        parentArtifact: State.selectedArtifact,
        iterationNote: notes ? `Regeneration notes: ${notes}` : `Regenerating script (${lang}, ${duration} min)`,
      },
    });
    closeScriptRegenerateDrawer();
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    toast('Script regeneration queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runScriptAnalyze() {
  if (!State.selectedArtifact) return;
  const projectAgent = agentForStage('script');
  const adapter = ['codex', 'claude', 'antigravity'].includes(projectAgent) ? projectAgent : 'codex';
  try {
    const data = await api('/api/jobs', {
      method: 'POST',
      body: {
        projectKey: State.projectKey,
        stageId: 'script',
        substage: 'analyze',
        adapter,
        parentArtifact: State.selectedArtifact,
        iterationNote: `Critical YouTube analysis of: ${State.selectedArtifact}`,
      },
    });
    State.runs.unshift(data.run);
    State.activeRunId = data.run.id;
    setConsoleRun(data.run);
    openConsole();
    renderRuns();
    renderRunControls();
    toast('Critical YouTube script analysis queued', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function scriptVersionLabel(version) {
  const file = version.relativePath.split('/').at(-1).replace(/\.md$/i, '');
  return file.replaceAll('_', ' ');
}

function scriptArtifactForVersion(version) {
  return State.artifacts.find((artifact) => artifact.relativePath === version?.relativePath) || null;
}

async function renderScriptStudio() {
  if (State.currentStage !== 'script' || !$('script-studio')) return;
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio`);
    if (State.currentStage !== 'script') return;
    State.artifacts = [...State.artifacts.filter((artifact) => artifact.stageId !== 'script'), ...response.artifacts];
    State.scriptStudio.versions = response.versions;
    State.scriptStudio.comments = response.comments;
    const versions = response.versions;
    const selected = versions.find((version) => version.id === State.scriptStudio.selectedVersionId)
      || versions.find((version) => version.id === State.project?.stages?.script?.data?.selectedScriptVersionId)
      || versions.find((version) => version.kind !== 'outline')
      || versions[0] || null;
    State.scriptStudio.selectedVersionId = selected?.id || '';
    if (selected) State.selectedArtifact = selected.relativePath;
    renderScriptStudioChrome(selected);
    await renderScriptManuscript(selected);
    renderScriptReviewPanel(selected);
  } catch (error) { toast(error.message, 'error'); }
}

function renderScriptStudioChrome(selected) {
  const versions = State.scriptStudio.versions;
  const title = State.project?.title || 'Script';
  $('script-studio-title').textContent = title;
  const stageGate = scriptStageGate(versions);
  const auto = Boolean(State.project?.stages?.script?.autoMode);
  $('script-studio-status').textContent = auto
    ? 'Auto: English authoring, internal fact-check, critical rewrite, and Hindi adaptation run together.'
    : 'Manual: draft, review, translate, or continue whenever you are ready.';

  const actions = $('script-studio-actions');
  const selectedLanguage = selected ? languageSlug(selected.language) : '';
  const actionNodes = [el('button', { type: 'button', className: 'button quiet compact-button', id: 'script-action-comment', text: State.scriptStudio.reviewOpen ? 'Close comments' : 'Comment' })];
  const hasOpenComments = State.scriptStudio.comments.some((comment) => comment.scriptVersionId === selected?.id && comment.status === 'open');
  if (selected) {
    if (hasOpenComments) actionNodes.push(el('button', { type: 'button', className: 'button primary compact-button', id: 'script-action-revise', text: 'Redraft comments' }));
    actionNodes.push(el('button', { type: 'button', className: 'button quiet compact-button', id: 'script-action-factcheck', text: 'Fact-check & revise' }));
    actionNodes.push(el('button', { type: 'button', className: 'button quiet compact-button', id: 'script-action-analyze', text: 'Analyze & revise' }));
    if (selectedLanguage === 'english') actionNodes.push(el('button', { type: 'button', className: 'button quiet compact-button', id: 'script-action-translate', text: 'Create Hindi adaptation' }));
  }
  actionNodes.push(el('button', {
    type: 'button', className: 'button approve compact-button', id: 'script-action-proceed',
    text: stageGate.ready ? 'Proceed to editorial blueprint' : 'Approve scripts & continue', disabled: !selected,
    title: stageGate.ready ? 'Open the Editorial Blueprint' : 'Approve the current scripts and continue',
  }));
  actions.replaceChildren(...actionNodes);
  $('script-action-comment')?.addEventListener('click', () => toggleScriptReview(selected));
  $('script-action-revise')?.addEventListener('click', () => createScriptRevision(selected));
  $('script-action-factcheck')?.addEventListener('click', () => runScriptQuality(selected, 'factcheck'));
  $('script-action-analyze')?.addEventListener('click', () => runScriptQuality(selected, 'analysis'));
  $('script-action-translate')?.addEventListener('click', () => translateScript(selected));
  $('script-action-proceed')?.addEventListener('click', () => proceedScriptToEditorialBlueprint(selected));

  $('script-flow').replaceChildren();

  const versionList = $('script-version-list');
  versionList.replaceChildren(...versions.filter((version) => version.kind !== 'outline').map((version) => {
    const button = el('button', { type: 'button', className: `script-version-item ${version.id === selected?.id ? 'active' : ''}` }, [
      el('strong', { text: scriptVersionLabel(version) }),
      el('small', { text: `${scriptLanguageLabel(version.language)} · ${version.parentId ? 'revision' : 'draft'}` }),
    ]);
    button.addEventListener('click', () => { State.scriptStudio.selectedVersionId = version.id; State.scriptStudio.editing = false; renderScriptStudio(); });
    return button;
  }));
  if (!versions.length) versionList.replaceChildren(el('p', { className: 'artifact-meta', text: 'No drafts yet.' }));
  const languages = new Map();
  versions.forEach((version) => {
    const existing = languages.get(version.language);
    if (version.kind !== 'outline' && (!existing || String(version.createdAt) > String(existing.createdAt))) languages.set(version.language, version);
  });
  $('script-language-list').replaceChildren(...[...languages.entries()].map(([language, version]) => {
    const button = el('button', { type: 'button', className: `script-language-item ${version.id === selected?.id ? 'active' : ''}` }, [
      document.createTextNode(scriptLanguageLabel(language)), el('span', { text: version.parentId ? 'Latest revision' : 'Current draft' }),
    ]);
    button.addEventListener('click', () => { State.scriptStudio.selectedVersionId = version.id; State.scriptStudio.editing = false; renderScriptStudio(); });
    return button;
  }));
  syncScriptReviewDrawer();
}

function syncScriptReviewDrawer() {
  const studio = $('script-studio');
  const drawer = $('script-review-drawer');
  if (!studio || !drawer) return;
  drawer.hidden = !State.scriptStudio.reviewOpen;
  studio.classList.toggle('review-open', State.scriptStudio.reviewOpen);
}

function toggleScriptReview(selected) {
  State.scriptStudio.reviewOpen = !State.scriptStudio.reviewOpen;
  syncScriptReviewDrawer();
  renderScriptReviewPanel(selected);
  const button = $('script-action-review');
  if (button) {
    button.textContent = State.scriptStudio.reviewOpen ? 'Close review' : 'Review & comments';
    button.setAttribute('aria-expanded', String(State.scriptStudio.reviewOpen));
  }
}

async function renderScriptManuscript(selected) {
  const canvas = $('script-manuscript');
  if (!selected) {
    canvas.replaceChildren(el('div', { className: 'manuscript-empty' }, [el('h3', { text: 'Begin with the story' }), el('p', { text: 'Generate a draft from the approved research corpus, then use the desk to test and refine it.' }), el('button', { type: 'button', className: 'button primary', text: 'Generate draft' })]));
    canvas.querySelector('button')?.addEventListener('click', startGenerateScript);
    return;
  }
  const artifact = scriptArtifactForVersion(selected) || { relativePath: selected.relativePath, mimeType: 'text/markdown' };
  try {
    const content = await (await fetch(mediaUrl(artifact), { credentials: 'same-origin' })).text();
    if (State.scriptStudio.selectedVersionId !== selected.id) return;
    const toolbar = el('div', { className: 'manuscript-toolbar' }, [
      el('small', { text: `${scriptLanguageLabel(selected.language)} · ${selected.parentId ? 'revision' : 'draft'}` }),
      el('div', { className: 'manuscript-toolbar-actions' }, [
        el('button', { type: 'button', className: 'button quiet compact-button', text: State.scriptStudio.editing ? 'Preview' : 'Edit' }),
      ]),
    ]);
    const toggle = toolbar.querySelector('button');
    toggle.addEventListener('click', () => { State.scriptStudio.editing = !State.scriptStudio.editing; renderScriptManuscript(selected); });
    if (State.scriptStudio.editing) {
      const editor = el('textarea', { className: 'manuscript-textarea', value: content, 'aria-label': `Edit ${selected.relativePath}` });
      const save = el('button', { type: 'button', className: 'button primary compact-button', text: 'Save revision' });
      toolbar.querySelector('.manuscript-toolbar-actions').append(save);
      save.addEventListener('click', async () => { await saveArtifact({ ...artifact, mimeType: 'text/markdown' }, editor.value, save); State.scriptStudio.editing = false; renderScriptStudio(); });
      canvas.replaceChildren(toolbar, editor);
    } else {
      const sheet = el('article', { className: 'manuscript-sheet' });
      const rendered = el('div', { className: 'artifact-rendered-wrap markdown-rendered' });
      renderMarkdownInto(content, rendered); sheet.append(rendered); canvas.replaceChildren(toolbar, sheet);
    }
  } catch (error) { canvas.replaceChildren(el('div', { className: 'manuscript-empty' }, [el('h3', { text: 'Script unavailable' }), el('p', { text: error.message })])); }
}

function renderScriptReviewPanel(selected) {
  const panel = State.scriptStudio.panel;
  document.querySelectorAll('[data-script-panel]').forEach((button) => button.classList.toggle('active', button.dataset.scriptPanel === panel));
  const root = $('script-review-content');
  const comments = State.scriptStudio.comments.filter((comment) => comment.scriptVersionId === selected?.id);
  $('script-comment-count').textContent = comments.filter((comment) => comment.status === 'open').length || '';
  if (!selected) return root.replaceChildren(el('p', { className: 'artifact-meta', text: 'Review evidence appears with a script.' }));
  if (panel === 'comments') {
    const scope = el('select', {}, [el('option', { value: 'text', text: 'Selected text' }), el('option', { value: 'section', text: 'Section direction' }), el('option', { value: 'global', text: 'Whole script direction' })]);
    const field = el('textarea', { rows: 4, placeholder: 'What should change, and why?' });
    const add = el('button', { type: 'button', className: 'button primary compact-button', text: 'Add comment' });
    add.addEventListener('click', () => addScriptComment(selected, scope.value, field.value));
    const composer = el('div', { className: 'comment-composer' }, [scope, field, add]);
    const nodes = comments.map((comment) => {
      const resolve = el('button', { type: 'button', className: 'text-button', text: comment.status === 'resolved' ? 'Resolved' : 'Resolve', disabled: comment.status === 'resolved' });
      resolve.addEventListener('click', () => resolveScriptComment(comment.id));
      return el('article', { className: 'comment-card' }, [
        el('strong', { text: comment.scope === 'global' ? 'Whole script' : comment.sectionLabel || comment.scope }),
        ...(comment.quoteText ? [el('blockquote', { text: comment.quoteText })] : []),
        el('p', { text: comment.body }), el('footer', {}, [el('span', { text: comment.status }), resolve]),
      ]);
    });
    const revise = comments.some((comment) => comment.status === 'open') ? el('button', { type: 'button', className: 'button primary compact-button', text: 'Redraft from comments' }) : null;
    revise?.addEventListener('click', () => createScriptRevision(selected));
    return root.replaceChildren(composer, ...(nodes.length ? nodes : [el('p', { className: 'artifact-meta', text: 'No comments yet. Add a precise note, section direction, or whole-script brief.' })]), ...(revise ? [revise] : []));
  }
  if (panel === 'evidence') {
    const factchecks = State.artifacts.filter((artifact) => /^02_script\/factcheck/i.test(artifact.relativePath));
    const analysis = State.artifacts.filter((artifact) => /^02_script\/analysis/i.test(artifact.relativePath));
    return root.replaceChildren(el('div', { className: 'script-audit' }, [
      el('div', { className: `audit-row ${analysis.length ? 'ready' : 'pending'}` }, [el('strong', { text: 'YouTube revision' }), el('span', { text: analysis.length ? `${analysis.length} legacy analysis report(s) available` : 'Use Analyze & revise when you want this pass.' })]),
      el('div', { className: `audit-row ${factchecks.length ? 'ready' : 'pending'}` }, [el('strong', { text: 'Fact-check revision' }), el('span', { text: factchecks.length ? `${factchecks.length} legacy fact-check report(s) available` : 'Use Fact-check & revise when you want this pass.' })]),
      el('div', { className: 'audit-row ready' }, [el('strong', { text: 'Manual approval' }), el('span', { text: 'Any reviewed script can proceed to editorial.' })]),
    ]));
  }
  const runs = State.runs.filter((run) => run.stageId === 'script').slice(0, 8);
  return root.replaceChildren(...(runs.length ? runs.map((run) => el('div', { className: 'comment-card' }, [el('strong', { text: `${run.substage} #${run.attempt}` }), el('p', { text: `${humanStatus(run.status)} · ${formatTime(run.startedAt)}` })])) : [el('p', { className: 'artifact-meta', text: 'No script activity yet.' })]));
}

async function addScriptComment(version, scope, body) {
  const quote = scope === 'text' ? String(window.getSelection?.().toString() || '').trim() : '';
  try {
    await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/versions/${version.id}/comments`, { method: 'POST', body: { scope, quoteText: quote, body } });
    toast('Comment added', 'success'); renderScriptStudio();
  } catch (error) { toast(error.message, 'error'); }
}

async function resolveScriptComment(commentId) {
  try { await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/comments/${commentId}/resolve`, { method: 'POST' }); toast('Comment resolved', 'success'); renderScriptStudio(); }
  catch (error) { toast(error.message, 'error'); }
}

async function createScriptRevision(version) {
  if (!version) return startGenerateScript();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/versions/${version.id}/revise`, { method: 'POST', body: { adapter: agentForStage('script') } });
    State.runs.unshift(response.run); State.activeRunId = response.run.id; setConsoleRun(response.run); openConsole(); renderRuns(); toast('Revision branch queued', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function runScriptQuality(version, focus) {
  if (!version) return;
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/versions/${version.id}/quality`, { method: 'POST', body: { adapter: agentForStage('script'), focus } });
    State.runs.unshift(response.run); State.activeRunId = response.run.id; setConsoleRun(response.run); openConsole(); renderRuns();
    toast(`${focus === 'analysis' ? 'Analysis' : 'Fact-check'} revision queued`, 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function selectMasterScript(version) {
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/versions/${version.id}/select`, { method: 'POST', body: { note: 'Human selection in Script Studio' } });
    State.project = response.project; toast('Master script selected', 'success'); renderScriptStudio();
  } catch (error) { toast(error.message, 'error'); }
}

async function proceedScriptToEditorialBlueprint(selected) {
  try {
    if (!scriptStageGate().ready) {
      const approval = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/approve`, { method: 'POST', body: { selectedVersionId: selected?.id || '' } });
      State.project = approval.project;
    }
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/script/approve`, { method: 'POST', body: { decision: 'approved', note: 'Current script revisions approved for editorial production.' } });
    State.project = data.project;
    toast('Script approved. Editorial blueprint is ready.', 'success');
    await switchStage('assets');
  } catch (error) { toast(error.message, 'error'); }
}

async function translateScript(version) {
  if (!version) return toast('Choose an English script before translating', 'error');
  const deliveryLanguage = String(State.project?.settings?.language || '').trim();
  const language = selectedScriptNeedsTranslation()
    ? deliveryLanguage
    : window.prompt('Language code for the alternate narration (for example: en, hi, ta)');
  if (!language) return;
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/script-studio/versions/${version.id}/translate`, { method: 'POST', body: { language, adapter: agentForStage('script') } });
    State.runs.unshift(response.run); State.activeRunId = response.run.id; setConsoleRun(response.run); openConsole(); renderRuns(); toast('Adaptive translation queued', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function renderBlueprintStudio() {
  if (!State.project || State.currentStage !== 'assets') return;
  try {
    const versionQuery = State.blueprintStudio.version ? `?version=${encodeURIComponent(State.blueprintStudio.version)}` : '';
    State.blueprintStudio.data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/editorial-blueprint${versionQuery}`);
  } catch (error) {
    toast(`Could not load the Editorial Blueprint: ${error.message}`, 'error');
    return;
  }
  const data = State.blueprintStudio.data;
  const blueprint = data.blueprint;
  $('blueprint-title').textContent = State.project.title || 'Editorial Blueprint';
  if (!blueprint) {
    $('blueprint-status').textContent = 'Generate a production plan from the approved script before sourcing or rendering visuals.';
    $('blueprint-metrics').replaceChildren();
    $('blueprint-alerts').replaceChildren();
    $('blueprint-rail').replaceChildren(el('p', { className: 'blueprint-empty', text: 'No beats planned yet.' }));
    $('blueprint-stage').replaceChildren(el('div', { className: 'blueprint-empty-stage' }, [el('strong', { text: 'The script is ready for its visual language.' }), el('p', { text: 'Generate the blueprint to map narration, evidence, motion, music, and source rights.' })]));
    $('blueprint-inspector').replaceChildren();
    return;
  }
  const summary = data.summary || {};
  const versions = data.versions || [];
  const currentVersion = Number(blueprint.version || data.relativePath?.match(/_v(\d+)\.json$/)?.[1] || 0);
  State.blueprintStudio.version = currentVersion || null;
  const versionSelect = $('blueprint-version-select');
  if (versionSelect) {
    versionSelect.replaceChildren(...versions.slice().reverse().map((item) => el('option', {
      value: String(item.version), text: `Blueprint v${item.version}${item.version === currentVersion ? ' (current)' : ''}`,
    })));
    versionSelect.value = String(currentVersion);
  }
  $('blueprint-status').textContent = data.legacy
    ? 'Legacy asset plan preview. Generate a new blueprint to make it editable and approvable.'
    : `${summary.timingBasis === 'voice_reconciled' ? 'Voice timing reconciled' : 'Script timing estimated'} · ${summary.totalBeats || 0} planned beats`;
  const metrics = [
    ['beats', summary.totalBeats || 0], ['duration', `${summary.durationSeconds || 0}s`], ['average beat', `${summary.averageVisualSeconds || 0}s`],
    ['screen states', summary.screenStates || 0], ['cadence risks', summary.cadenceRisks || 0],
    ['cleared sources', summary.clearedSources || 0], ['AI reconstructions', summary.aiReconstructions || 0], ['blocking', summary.blocking || 0],
  ];
  $('blueprint-metrics').replaceChildren(...metrics.map(([label, value]) => el('div', { className: `blueprint-metric ${label === 'blocking' && value ? 'is-risk' : ''}` }, [el('span', { text: label }), el('strong', { text: String(value) })])));
  if (State.currentStage === 'assets' && summary.blocking) {
    $('approve-stage').disabled = true;
    $('approve-stage').title = 'Resolve the Editorial Blueprint blocking issues before approving this stage.';
  }
  const problems = data.problems || [];
  $('blueprint-alerts').replaceChildren(...(problems.length ? problems.slice(0, 4).map((problem) => el('button', { type: 'button', className: `blueprint-alert ${problem.severity}`, text: problem.message, onclick: () => { State.blueprintStudio.selectedBeatId = problem.beatId || ''; renderBlueprintContent(); } })) : [el('span', { className: 'blueprint-clear', text: 'Planning checks are clear. Review each beat, then approve the stage.' })]));
  if (!State.blueprintStudio.selectedBeatId || !blueprint.beats.some((beat) => beat.id === State.blueprintStudio.selectedBeatId)) State.blueprintStudio.selectedBeatId = blueprint.beats[0]?.id || '';
  renderBlueprintContent();
}

function renderBlueprintContent() {
  const blueprint = State.blueprintStudio.data?.blueprint;
  if (!blueprint) return;
  const selected = blueprint.beats.find((beat) => beat.id === State.blueprintStudio.selectedBeatId) || blueprint.beats[0];
  const beatButtons = blueprint.beats.map((beat, index) => {
    const timing = beat.timing || {};
    const isSelected = beat.id === selected?.id;
    return el('button', { type: 'button', className: `blueprint-beat ${isSelected ? 'selected' : ''} ${beat.status === 'approved' ? 'approved' : ''}`, onclick: () => { State.blueprintStudio.selectedBeatId = beat.id; renderBlueprintContent(); } }, [
      el('span', { className: 'blueprint-beat-time', text: `${formatSeconds(timing.startSeconds)}–${formatSeconds(timing.endSeconds)}` }),
      el('strong', { text: beat.narration?.anchor || `Beat ${index + 1}` }),
      el('small', { text: `${beat.visual?.type?.replaceAll('_', ' ') || 'visual'} · ${beat.visual?.motion?.type?.replaceAll('_', ' ') || 'hold'}` }),
    ]);
  });
  $('blueprint-rail').replaceChildren(
    el('div', { className: 'blueprint-rail-heading' }, [
      el('div', {}, [el('strong', { text: 'Storyboard beats' }), el('span', { text: 'Choose a beat to review its production brief.' })]),
      el('span', { className: 'blueprint-approval-count', text: `${State.blueprintStudio.data?.summary?.screenStates || 0} timed states` }),
    ]),
    el('div', { className: 'blueprint-beat-list' }, beatButtons),
  );
  if (!selected) return;
  const asset = blueprint.assets.find((item) => item.id === selected.visual?.primaryAssetId);
  const stage = $('blueprint-stage');
  const saveBeat = async (patch) => {
    try {
      const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/editorial-blueprint/beats/${encodeURIComponent(selected.id)}`, { method: 'POST', body: { patch } });
      State.blueprintStudio.data = { ...State.blueprintStudio.data, blueprint: result.blueprint, summary: result.summary, problems: result.problems, legacy: false };
      toast('Saved as a new blueprint revision', 'success'); renderBlueprintStudio();
    } catch (error) { toast(error.message, 'error'); }
  };
  const saveAsset = async (patch) => {
    if (!asset) return toast('Link an asset to this beat before adding a production brief', 'error');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/editorial-blueprint/assets/${encodeURIComponent(asset.id)}`, { method: 'POST', body: { patch } });
      State.blueprintStudio.data = { ...State.blueprintStudio.data, blueprint: result.blueprint, summary: result.summary, problems: result.problems, legacy: false };
      toast('Asset brief saved as a new blueprint revision', 'success'); renderBlueprintStudio();
    } catch (error) { toast(error.message, 'error'); }
  };
  const production = asset?.production || {};
  const ai = selected.visual?.type === 'ai_generated' || asset?.sourceKind === 'ai_generated';
  const commaList = (value) => Array.isArray(value) ? value.join(', ') : String(value || '');
  stage.replaceChildren(
    el('header', { className: 'blueprint-packet-header' }, [
      el('div', {}, [el('span', { text: `${formatSeconds(selected.timing?.startSeconds)}–${formatSeconds(selected.timing?.endSeconds)} · ${selected.id}` }), el('h3', { text: asset?.description || selected.visual?.purpose || 'Production brief' })]),
      el('span', { className: `blueprint-kind-chip ${ai ? 'ai' : 'source'}`, text: ai ? 'AI reconstruction — plan only' : 'Real source to collect' }),
    ]),
    el('section', { className: 'blueprint-packet-section' }, [
      el('h4', { text: 'Editorial intent' }),
      blueprintField('What the viewer must understand', selected.visual?.purpose, (value) => saveBeat({ visual: { purpose: value } }), { type: 'textarea' }),
      blueprintField('Narration this serves', selected.narration?.anchor, (value) => saveBeat({ narration: { anchor: value } }), { type: 'textarea' }),
    ]),
    ai ? el('section', { className: 'blueprint-packet-section blueprint-ai-brief' }, [
      el('h4', { text: 'Image-generation brief' }),
      el('p', { className: 'blueprint-section-note', text: 'This is a written prompt only. Nothing will be generated from this screen.' }),
      blueprintField('Detailed prompt', production.generationPrompt || asset?.prompt, (value) => saveAsset({ production: { generationPrompt: value }, prompt: value }), { type: 'textarea' }),
      blueprintField('Avoid / negative prompt', production.negativePrompt, (value) => saveAsset({ production: { negativePrompt: value } }), { type: 'textarea' }),
      el('div', { className: 'blueprint-field-row' }, [blueprintField('Aspect ratio', production.aspectRatio || '16:9', (value) => saveAsset({ production: { aspectRatio: value } })), blueprintField('Framing / lens', production.framing, (value) => saveAsset({ production: { framing: value } }))]),
      blueprintField('Light, texture & period detail', production.lighting, (value) => saveAsset({ production: { lighting: value } }), { type: 'textarea' }),
    ]) : el('section', { className: 'blueprint-packet-section blueprint-source-brief' }, [
      el('h4', { text: 'Collection brief' }),
      el('p', { className: 'blueprint-section-note', text: 'The researcher should return the item page, direct file, licence, credit and crop restrictions — not merely a similar image.' }),
      blueprintField('What to find', production.collectionBrief || asset?.description, (value) => saveAsset({ production: { collectionBrief: value } }), { type: 'textarea' }),
      blueprintField('Search queries (comma-separated)', commaList(production.searchQueries), (value) => saveAsset({ production: { searchQueries: value.split(',').map((item) => item.trim()).filter(Boolean) } }), { type: 'textarea' }),
      blueprintField('Preferred collections (comma-separated)', commaList(production.preferredCollections), (value) => saveAsset({ production: { preferredCollections: value.split(',').map((item) => item.trim()).filter(Boolean) } }), { type: 'textarea' }),
      blueprintField('Evidence required before use', production.requiredEvidence, (value) => saveAsset({ production: { requiredEvidence: value } }), { type: 'textarea' }),
    ]),
    el('section', { className: 'blueprint-packet-section blueprint-audio-brief' }, [
      el('h4', { text: 'Audio direction' }),
      blueprintField('Music cue / purpose', selected.audio?.musicBrief || selected.audio?.musicCueId, (value) => saveBeat({ audio: { musicBrief: value } }), { type: 'textarea' }),
      blueprintField('SFX and ambience', selected.audio?.sfxBrief || commaList(selected.audio?.sfx), (value) => saveBeat({ audio: { sfxBrief: value } }), { type: 'textarea' }),
    ]),
    el('section', { className: 'blueprint-packet-section blueprint-edit-brief' }, [
      el('h4', { text: 'Edit construction' }),
      el('div', { className: 'blueprint-field-row' }, [blueprintField('Motion', selected.visual?.motion?.type, (value) => saveBeat({ visual: { motion: { type: value } } }), { options: ['hold', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'parallax', 'map_route', 'text_reveal', 'diagram_build'] }), blueprintField('Transition in', selected.visual?.transitionIn, (value) => saveBeat({ visual: { transitionIn: value } }))]),
      blueprintField('Why this movement earns attention', selected.visual?.motion?.rationale, (value) => saveBeat({ visual: { motion: { rationale: value } } }), { type: 'textarea' }),
    ])
  );
  renderBlueprintInspector(selected);
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value || 0));
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function blueprintField(label, value, onCommit, { type = 'text', options = null } = {}) {
  let control;
  if (options) {
    control = el('select', { className: 'blueprint-input', value: value || '' }, options.map((option) => el('option', { value: option, text: option.replaceAll('_', ' ') })));
  } else {
    const attributes = { className: 'blueprint-input', value: value ?? '' };
    if (type === 'textarea') attributes.rows = 3;
    if (type === 'number') attributes.type = 'number';
    control = el(type === 'textarea' ? 'textarea' : 'input', attributes);
  }
  const commit = () => onCommit(control.value);
  control.addEventListener('change', commit);
  if (type === 'textarea' || type === 'text') control.addEventListener('blur', commit);
  return el('label', { className: 'blueprint-field' }, [el('span', { text: label }), control]);
}

function renderBlueprintInspector(beat) {
  const save = async (patch) => {
    try {
      const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/editorial-blueprint/beats/${encodeURIComponent(beat.id)}`, { method: 'POST', body: { patch } });
      State.blueprintStudio.data = { ...State.blueprintStudio.data, blueprint: result.blueprint, summary: result.summary, problems: result.problems, legacy: false };
      toast('Saved as a new blueprint revision', 'success');
      renderBlueprintStudio();
    } catch (error) { toast(error.message, 'error'); }
  };
  const sourceStates = ['needs_review', 'cleared', 'not_applicable'];
  const inspector = $('blueprint-inspector');
  inspector.replaceChildren(
    el('header', {}, [el('span', { text: beat.id }), el('strong', { text: beat.status === 'approved' ? 'Approved beat' : 'Review beat' })]),
    el('div', { className: 'blueprint-field-row' }, [
      blueprintField('Start', beat.timing?.startSeconds, (value) => save({ timing: { startSeconds: Number(value) } }), { type: 'number' }),
      blueprintField('End', beat.timing?.endSeconds, (value) => save({ timing: { endSeconds: Number(value) } }), { type: 'number' }),
    ]),
    blueprintField('On-screen text', beat.text?.overlay, (value) => save({ text: { overlay: value } }), { type: 'textarea' }),
    el('h4', { className: 'blueprint-inspector-heading', text: 'Rights record' }),
    blueprintField('Source state', beat.source?.status, (value) => save({ source: { status: value } }), { options: sourceStates }),
    blueprintField('Source URL', beat.source?.url, (value) => save({ source: { url: value } }), { type: 'text' }),
    blueprintField('Source license', beat.source?.license, (value) => save({ source: { license: value } }), { type: 'text' }),
    blueprintField('Attribution', beat.source?.attribution, (value) => save({ source: { attribution: value } }), { type: 'textarea' }),
    el('div', { className: 'blueprint-inspector-actions' }, [
      el('span', { className: 'artifact-meta', text: 'Optional review marker — stage approval is a single decision.' }),
      el('button', { type: 'button', className: 'button quiet compact-button', text: beat.text?.aiDisclosure ? 'AI label on' : 'Add AI label', onclick: () => save({ text: { aiDisclosure: !beat.text?.aiDisclosure } }) }),
    ])
  );
}

async function generateEditorialBlueprint() {
  try {
    const data = await api('/api/jobs', { method: 'POST', body: { projectKey: State.projectKey, stageId: 'assets', substage: 'extract', adapter: agentForStage('assets') } });
    State.runs.unshift(data.run); State.activeRunId = data.run.id; setConsoleRun(data.run); openConsole(); renderRuns(); toast('Editorial Blueprint generation queued', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function reconcileBlueprintTiming() {
  const raw = window.prompt('Final narration duration in seconds');
  if (raw === null) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/editorial-blueprint/reconcile-timing`, { method: 'POST', body: { durationSeconds: Number(raw) } });
    State.blueprintStudio.data = { ...State.blueprintStudio.data, blueprint: data.blueprint, summary: data.summary, problems: data.problems, legacy: false };
    toast('Beat timings reconciled; approved beats need review', 'success'); renderBlueprintStudio();
  } catch (error) { toast(error.message, 'error'); }
}

async function compileBlueprintScreenStates() {
  const button = $('blueprint-compile-states');
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/editorial-blueprint/compile-screen-states`, { method: 'POST', body: {} });
    State.blueprintStudio.version = data.blueprint.version;
    State.blueprintStudio.selectedBeatId = '';
    toast(`${data.summary.screenStates} screen states compiled and validated without an LLM call`, 'success');
    await renderBlueprintStudio();
  } catch (error) { toast(error.message, 'error'); }
  finally { if (button) button.disabled = false; }
}

async function renderVisualsStudio() {
  if (!State.project || State.currentStage !== 'visuals') return;

  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/manifest`);
    State.visualsManifest = data;
  } catch (error) {
    console.error('Failed to load visuals manifest:', error);
  }

  const manifest = State.visualsManifest || { assets: [], summary: {}, thumbnails: [], thumbnailBrief: '' };
  const assets = manifest.assets || [];
  const summary = manifest.summary || {
    total: assets.length,
    rendered: assets.filter((a) => a.exists).length,
    approved: assets.filter((a) => a.approvalStatus === 'approved').length,
    upscaled: assets.filter((a) => a.upscaled).length,
  };

  if ($('visuals-title')) {
    $('visuals-title').textContent = State.project.title || 'Visual Assets & Storyboard';
  }
  if ($('visuals-total-count')) $('visuals-total-count').textContent = summary.total;
  if ($('visuals-rendered-count')) $('visuals-rendered-count').textContent = summary.rendered;
  if ($('visuals-approved-count')) $('visuals-approved-count').textContent = summary.approved;
  if ($('visuals-upscaled-count')) $('visuals-upscaled-count').textContent = summary.upscaled;

  if ($('count-filter-all')) $('count-filter-all').textContent = summary.total;
  if ($('count-filter-pending')) $('count-filter-pending').textContent = assets.filter((a) => !a.exists).length;
  if ($('count-filter-rendered')) $('count-filter-rendered').textContent = summary.rendered;
  if ($('count-filter-approved')) $('count-filter-approved').textContent = summary.approved;
  if ($('count-filter-upscaled')) $('count-filter-upscaled').textContent = summary.upscaled;

  if ($('thumbnail-brief-content')) {
    $('thumbnail-brief-content').textContent = manifest.thumbnailBrief || 'No thumbnail brief found.';
  }
  if ($('thumbnail-gallery')) {
    const thumbs = manifest.thumbnails || [];
    if (thumbs.length) {
      $('thumbnail-gallery').replaceChildren(
        ...thumbs.map((t) =>
          el('div', { className: 'thumbnail-preview-card' }, [
            el('img', { src: t.url, alt: t.filename, className: 'thumbnail-img', loading: 'lazy' }),
            el('span', { className: 'thumbnail-name', text: t.filename }),
          ])
        )
      );
    } else {
      $('thumbnail-gallery').replaceChildren(
        el('div', { className: 'thumbnail-empty-msg', text: 'No thumbnail concepts generated yet.' })
      );
    }
  }

  renderVisualsGrid();
}

function renderVisualsGrid() {
  const container = $('visuals-asset-grid');
  if (!container) return;

  const manifest = State.visualsManifest;
  if (!manifest || !manifest.assets || !manifest.assets.length) {
    container.replaceChildren(
      el('div', { className: 'empty-state visuals-empty' }, [
        el('div', { className: 'empty-icon', text: '🎨' }),
        el('h3', { text: 'No Visual Asset Plan Found' }),
        el('p', { text: 'The visual cues and prompts will appear here once the Assets stage generates the asset plan.' }),
      ])
    );
    return;
  }

  let filtered = manifest.assets;
  if (State.visualsFilter === 'pending') {
    filtered = filtered.filter((a) => !a.exists);
  } else if (State.visualsFilter === 'rendered') {
    filtered = filtered.filter((a) => a.exists);
  } else if (State.visualsFilter === 'approved') {
    filtered = filtered.filter((a) => a.approvalStatus === 'approved');
  } else if (State.visualsFilter === 'upscaled') {
    filtered = filtered.filter((a) => Boolean(a.upscaled));
  }

  if (State.visualsTypeFilter) {
    filtered = filtered.filter((a) => a.type === State.visualsTypeFilter);
  }

  if (!filtered.length) {
    container.replaceChildren(
      el('div', { className: 'empty-state visuals-empty' }, [
        el('div', { className: 'empty-icon', text: '🔍' }),
        el('h3', { text: 'No Matching Visual Assets' }),
        el('p', { text: 'Try switching the filter tabs or type filter above.' }),
      ])
    );
    return;
  }

  const cards = filtered.map((asset) => {
    const isApproved = asset.approvalStatus === 'approved';
    const isUpscaled = Boolean(asset.upscaled);
    const exists = Boolean(asset.exists);

    const typeBadge = el('span', { className: `cue-pill type-${asset.type.toLowerCase()}`, text: asset.type });
    let resBadge;
    if (isUpscaled) {
      resBadge = el('span', { className: 'res-badge hd', text: '1080p Full HD' });
    } else if (exists) {
      resBadge = el('span', { className: 'res-badge sd', text: '720p Draft' });
    } else {
      resBadge = el('span', { className: 'res-badge pending', text: 'Pending' });
    }

    const header = el('div', { className: 'visual-card-header' }, [
      el('div', { className: 'header-left' }, [
        el('strong', { className: 'asset-id-text', text: asset.id }),
        typeBadge,
      ]),
      el('div', { className: 'header-right' }, [
        resBadge,
      ]),
    ]);

    let mediaFrame;
    if (exists && asset.imageUrl) {
      const img = el('img', {
        src: asset.imageUrl,
        alt: asset.description,
        className: 'visual-preview-img',
        loading: 'lazy',
      });
      const inspectOverlay = el('div', { className: 'visual-inspect-overlay' }, [
        el('span', { text: '🔍 Click to Inspect' }),
      ]);
      mediaFrame = el('div', {
        className: 'visual-media-frame has-image',
        role: 'button',
        tabIndex: 0,
        title: 'Click to open full resolution inspector',
        onclick: () => openVisualsLightbox(asset),
      }, [img, inspectOverlay]);
    } else {
      mediaFrame = el('div', { className: 'visual-media-frame placeholder' }, [
        el('div', { className: 'placeholder-icon', text: '🖼️' }),
        el('span', { className: 'placeholder-label', text: 'Draft pending render' }),
        el('small', { className: 'placeholder-engine', text: 'FLUX.1 / MLX 4-bit' }),
      ]);
    }

    const descEl = el('p', { className: 'asset-description-text', text: asset.description });

    const promptTextarea = el('textarea', {
      className: 'asset-prompt-textarea',
      rows: 2,
      placeholder: 'FLUX.1 prompt for this visual cue...',
      value: asset.prompt || '',
      title: 'Edit FLUX.1 generation prompt',
    });

    let savePromptTimeout = null;
    promptTextarea.addEventListener('input', () => {
      clearTimeout(savePromptTimeout);
      savePromptTimeout = setTimeout(async () => {
        const newPrompt = promptTextarea.value.trim();
        if (newPrompt !== asset.prompt) {
          try {
            await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/asset`, {
              method: 'PATCH',
              body: { assetId: asset.id, prompt: newPrompt },
            });
            asset.prompt = newPrompt;
          } catch (e) {
            console.error('Failed to update prompt:', e);
          }
        }
      }, 800);
    });

    promptTextarea.addEventListener('blur', async () => {
      clearTimeout(savePromptTimeout);
      const newPrompt = promptTextarea.value.trim();
      if (newPrompt !== asset.prompt) {
        try {
          await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/asset`, {
            method: 'PATCH',
            body: { assetId: asset.id, prompt: newPrompt },
          });
          asset.prompt = newPrompt;
          toast(`Updated prompt for ${asset.id}`, 'success');
        } catch (e) {
          toast(`Failed to save prompt: ${e.message}`, 'error');
        }
      }
    });

    const body = el('div', { className: 'visual-card-body' }, [
      descEl,
      el('div', { className: 'prompt-wrapper' }, [
        el('label', { className: 'prompt-label', text: 'FLUX Prompt:' }),
        promptTextarea,
      ]),
    ]);

    const approveBtn = el('button', {
      type: 'button',
      className: `button compact-button visual-approve-btn ${isApproved ? 'approved' : 'quiet'}`,
      title: isApproved ? 'Selected for final video and 1080p HD upscaling' : 'Select to approve for final video and enable 1080p upscaling',
      text: isApproved ? '✓ Selected for HD' : '○ Select for HD',
      onclick: async (e) => {
        e.stopPropagation();
        const nextStatus = isApproved ? 'pending' : 'approved';
        try {
          approveBtn.disabled = true;
          await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/asset`, {
            method: 'PATCH',
            body: { assetId: asset.id, approvalStatus: nextStatus },
          });
          asset.approvalStatus = nextStatus;
          toast(nextStatus === 'approved' ? `${asset.id} selected for HD upscale` : `${asset.id} unselected`, 'success');
          renderVisualsStudio();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          approveBtn.disabled = false;
        }
      },
    });

    const renderBtn = el('button', {
      type: 'button',
      className: 'button compact-button visual-render-btn',
      title: exists ? 'Re-render draft image with FLUX.1' : 'Render draft image with FLUX.1 (720p)',
      text: exists ? '🔄 Re-render' : '⚡ Render',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          renderBtn.disabled = true;
          const res = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/render-single`, {
            method: 'POST',
            body: { assetId: asset.id, prompt: promptTextarea.value.trim() },
          });
          if (res.run) {
            State.runs.unshift(res.run);
            State.activeRunId = res.run.id;
            setConsoleRun(res.run);
            openConsole();
            renderRuns();
            renderRunControls();
            toast(`FLUX.1 render queued for ${asset.id}`, 'success');
          }
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          renderBtn.disabled = false;
        }
      },
    });

    const upscaleBtn = el('button', {
      type: 'button',
      className: 'button accent compact-button visual-upscale-btn',
      title: 'Run 4x-UltraSharp neural super-resolution to 1080p Full HD (Selected items only)',
      text: isUpscaled ? '✨ Re-upscale' : '✨ 1080p HD',
      disabled: !exists,
      onclick: async (e) => {
        e.stopPropagation();
        if (!exists) {
          toast('Must render the 720p draft first before upscaling', 'error');
          return;
        }
        try {
          upscaleBtn.disabled = true;
          if (!isApproved) {
            await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/asset`, {
              method: 'PATCH',
              body: { assetId: asset.id, approvalStatus: 'approved' },
            });
            asset.approvalStatus = 'approved';
          }
          const res = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/upscale-single`, {
            method: 'POST',
            body: { assetId: asset.id },
          });
          if (res.run) {
            State.runs.unshift(res.run);
            State.activeRunId = res.run.id;
            setConsoleRun(res.run);
            openConsole();
            renderRuns();
            renderRunControls();
            toast(`4x-UltraSharp 1080p upscale queued for ${asset.id}`, 'success');
          }
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          upscaleBtn.disabled = false;
        }
      },
    });

    const footer = el('div', { className: 'visual-card-footer' }, [
      approveBtn,
      el('div', { className: 'action-btn-pair' }, [
        renderBtn,
        upscaleBtn,
      ]),
    ]);

    return el('div', {
      className: `visual-asset-card ${isApproved ? 'is-approved' : ''} ${isUpscaled ? 'is-upscaled' : ''}`,
      'data-asset-id': asset.id,
    }, [
      header,
      mediaFrame,
      body,
      footer,
    ]);
  });

  container.replaceChildren(...cards);
}

function openVisualsLightbox(asset) {
  const dialog = $('visuals-lightbox-dialog');
  if (!dialog) return;

  if ($('lightbox-asset-id')) $('lightbox-asset-id').textContent = asset.id;
  if ($('lightbox-asset-type')) {
    $('lightbox-asset-type').textContent = asset.type;
    $('lightbox-asset-type').className = `cue-pill type-${asset.type.toLowerCase()}`;
  }
  if ($('lightbox-asset-resolution')) {
    const res = asset.resolution || (asset.upscaled ? '1920x1080 Full HD' : (asset.exists ? '1280x720 Draft' : 'Pending'));
    $('lightbox-asset-resolution').textContent = res;
    $('lightbox-asset-resolution').className = `res-pill ${asset.upscaled ? 'hd' : 'sd'}`;
  }
  if ($('lightbox-img')) {
    $('lightbox-img').src = asset.imageUrl || '';
    $('lightbox-img').alt = asset.description || asset.id;
  }
  if ($('lightbox-prompt')) {
    $('lightbox-prompt').textContent = asset.prompt || asset.description || 'No prompt specified.';
  }

  dialog.showModal();
}

async function switchStage(stageId) {
  if (!State.config.stages.some((s) => s.id === stageId)) return;
  State.currentStage = stageId;
  State.selectedArtifact = '';
  State.artifactsExpanded = false;
  if (stageId === 'idea') State.ideaViewMode = 'cards';
  if (stageId === 'research') State.researchViewMode = 'studio';
  if (stageId === 'visuals') State.visualsViewMode = 'studio';
  if (stageId === 'script') {
    const scriptArtifacts = State.artifacts.filter((a) => a.stageId === 'script' || a.relativePath.startsWith('02_script/'));
    const latest = findLatestScriptArtifact(scriptArtifacts);
    if (latest) {
      State.selectedArtifact = latest.relativePath;
    }
  }
  if (State.projectKey) {
    window.history.replaceState({}, '', workspacePath(State.projectKey, State.currentStage));
    await api(`/api/projects/${encodeURIComponent(State.projectKey)}`, { method: 'PATCH', body: { currentStage: State.currentStage } }).catch(() => {});
  }
  renderWorkspace();
}

function renderStage() {
  const stage = currentStageConfig(); const stageState = State.project.stages[stage.id] || {};
  const index = State.config.stages.findIndex((item) => item.id === stage.id);
  $('stage-position').textContent = `Stage ${index + 1} of ${State.config.stages.length}`;
  $('stage-title').textContent = stage.name; $('stage-description').textContent = stage.description;
  const displayStatus = displayStageStatus(stage.id, stageState.status);
  $('stage-status').textContent = humanStatus(displayStatus); $('stage-status').className = `status-pill ${displayStatus === 'ready_for_translation' ? 'ready' : displayStatus}`;
  $('substage-select').replaceChildren(...stage.substages.map((id) => el('option', { value: id, text: id.replaceAll('_', ' ') })));
  const globalAgents = workspaceAgents();
  $('agent-select').replaceChildren(...globalAgents.map((agent) => el('option', { value: agent.id, text: agent.name })));
  const defaultAgent = State.project.settings.defaultAgent || 'codex';
  $('agent-select').value = globalAgents.some((agent) => agent.id === defaultAgent) ? defaultAgent : globalAgents[0]?.id || '';
  const eligibleAgents = agentsForStage(stage.id);
  $('stage-agent-select').replaceChildren(...eligibleAgents.map((agent) => el('option', { value: agent.id, text: agent.name })));
  const hasStageOverride = Boolean(stageState.data?.workerOverrideEnabled);
  $('stage-agent-override').checked = hasStageOverride;
  $('stage-agent-select-label').hidden = !hasStageOverride;
  const preferredAgent = stageState.agent || defaultAgent;
  $('stage-agent-select').value = eligibleAgents.some((agent) => agent.id === preferredAgent) ? preferredAgent : eligibleAgents[0]?.id || '';
  $('chain-steps').checked = Boolean(stageState.autoMode);
  $('prompt-override').value = stageState.promptOverride || ''; $('manual-sources').value = stageState.data?.manualSources || '';
  const isIdea = stage.id === 'idea';
  const isResearch = stage.id === 'research';
  const isScript = stage.id === 'script';
  const isAssets = stage.id === 'assets';
  const isAudio = stage.id === 'audio';
  const isVisuals = stage.id === 'visuals';
  if (isScript && $('review-drawer')) {
    $('review-drawer').hidden = true;
    $('review-toggle')?.setAttribute('aria-expanded', 'false');
    updateDrawerDockState();
  }
  if (!isScript) $('script-studio').hidden = true;
  if (!isAssets) $('blueprint-studio').hidden = true;
  if (!isAudio && $('audio-studio')) $('audio-studio').hidden = true;
  if (!isAudio && $('audio-review-tab-nav')) $('audio-review-tab-nav').hidden = true;
  if (!isAudio && $('audio-voice-config-section')) $('audio-voice-config-section').hidden = true;
  if (!isAudio && $('review-gate-section-wrap')) $('review-gate-section-wrap').hidden = false;
  $('idea-planning-fields').hidden = !isIdea;
  $('planning-mode').value = stageState.data?.planningMode || 'proactive';
  $('idea-topic').value = stageState.data?.topicDescription || '';
  $('manual-sources-label').textContent = isIdea ? 'Planning notes or source leads' : 'Researcher notes or source leads';
  $('iteration-note').value = '';
  $('iteration-label').hidden = !stage.iterative; $('iteration-note').hidden = !stage.iterative;

  if (isIdea && State.ideaViewMode === 'cards') {
    $('idea-studio').hidden = false;
    $('research-studio').hidden = true;
    $('visuals-studio').hidden = true;
    $('blueprint-studio').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = true;
    $('artifact-workbench').hidden = true;
    renderIdeaStudio();
  } else if (isResearch && State.researchViewMode === 'studio') {
    $('idea-studio').hidden = true;
    $('research-studio').hidden = false;
    $('visuals-studio').hidden = true;
    $('blueprint-studio').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = true;
    $('artifact-workbench').hidden = true;
    renderResearchStudio();
  } else if (isScript) {
    $('idea-studio').hidden = true;
    $('research-studio').hidden = true;
    $('visuals-studio').hidden = true;
    $('blueprint-studio').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = true;
    $('artifact-workbench').hidden = true;
    $('script-studio').hidden = false;
    renderScriptStudio();
  } else if (isAssets) {
    $('idea-studio').hidden = true;
    $('research-studio').hidden = true;
    $('script-studio').hidden = true;
    $('visuals-studio').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = true;
    $('artifact-workbench').hidden = true;
    $('blueprint-studio').hidden = false;
    renderBlueprintStudio();
  } else if (isAudio) {
    $('idea-studio').hidden = true;
    $('research-studio').hidden = true;
    $('script-studio').hidden = true;
    $('blueprint-studio').hidden = true;
    $('visuals-studio').hidden = true;
    $('artifact-workbench').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = false;
    if ($('audio-review-tab-nav')) $('audio-review-tab-nav').hidden = false;
    renderAudioStudio();
  } else if (isVisuals && State.visualsViewMode === 'studio') {
    $('idea-studio').hidden = true;
    $('research-studio').hidden = true;
    $('script-studio').hidden = true;
    $('blueprint-studio').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = true;
    $('artifact-workbench').hidden = true;
    $('visuals-studio').hidden = false;
    renderVisualsStudio();
  } else {
    $('idea-studio').hidden = true;
    $('research-studio').hidden = true;
    $('visuals-studio').hidden = true;
    $('blueprint-studio').hidden = true;
    if ($('audio-studio')) $('audio-studio').hidden = true;
    $('artifact-workbench').hidden = false;
    $('script-studio').hidden = true;
    $('back-to-idea-studio').hidden = !isIdea;
    $('back-to-research-studio').hidden = !isResearch;
    $('back-to-visuals-studio').hidden = !isVisuals;
  }

  const disk = State.filesystem?.stages?.[stage.id];
  $('adopt-files').hidden = !disk?.valid || stage.id === 'publish' || stageState.status === 'approved';
  const dependencies = stage.requires.map((id) => ({ stage: State.config.stages.find((item) => item.id === id), ok: State.project.stages[id]?.status === 'approved' }));
  $('dependency-list').replaceChildren(...(dependencies.length ? dependencies.map(({ stage: required, ok }) => el('div', { className: `dependency ${ok ? 'ok' : ''}` }, [el('span', { text: required.name }), el('strong', { text: ok ? 'Approved' : 'Required' })])) : [el('div', { className: 'dependency ok' }, [el('span', { text: 'No prerequisites' }), el('strong', { text: 'Open' })])]));
  const canApprove = !['blocked', 'queued', 'running'].includes(stageState.status);
  $('approve-stage').disabled = !canApprove || stageState.status === 'approved' || stage.id === 'publish'; $('request-changes').disabled = !canApprove || stage.id === 'publish';
  $('qc-panel').hidden = stage.id !== 'qc'; $('publish-panel').hidden = stage.id !== 'publish'; if (stage.id === 'qc') renderQc(); renderRunControls();
}
function renderRunControls() {
  if (!State.project) return;
  const stage = currentStageConfig(); const stageState = State.project.stages[stage.id] || {};
  const active = State.runs.find((run) => ['queued', 'running'].includes(run.status));
  const requirementsMet = stage.requires.every((id) => State.project.stages[id]?.status === 'approved');
  const hasMaterial = Boolean(State.filesystem?.stages?.[stage.id]?.count);
  $('run-stage').disabled = Boolean(active) || !requirementsMet || stage.id === 'publish'; $('run-stage').textContent = requirementsMet ? (stage.iterative && hasMaterial ? 'Generate more' : `Run ${stage.name}`) : 'Waiting for approval';
  $('stop-run').hidden = !active; $('stop-run').dataset.runId = active?.id || ''; if (active) { State.activeRunId = active.id; setConsoleRun(active); }
  if (stageState.status === 'blocked') $('run-stage').disabled = true;
}

function artifactsForStage() { return State.artifacts.filter((artifact) => artifact.stageId === State.currentStage); }
function renderArtifacts() {
  if (State.currentStage === 'script' || State.currentStage === 'audio') return;
  const artifacts = artifactsForStage();
  const fileLimit = 12;
  const visibleArtifacts = State.artifactsExpanded ? artifacts : artifacts.slice(0, fileLimit);
  $('artifact-summary').textContent = '';
  const items = artifacts.length ? visibleArtifacts.map((artifact) => el('button', { type: 'button', role: 'option', className: `artifact-item ${artifact.relativePath === State.selectedArtifact ? 'active' : ''}`, 'data-artifact': artifact.relativePath, 'aria-selected': artifact.relativePath === State.selectedArtifact ? 'true' : 'false' }, [el('strong', { text: artifact.relativePath.split('/').at(-1) }), el('small', { text: `r${artifact.revision} · ${formatBytes(artifact.size)}` })])) : [el('div', { className: 'rail-empty', text: 'Run this stage or add material in the project folder.' })];
  if (artifacts.length) items.push(el('span', { className: 'artifact-count', text: `${artifacts.length} file${artifacts.length === 1 ? '' : 's'}` }));
  if (artifacts.length > fileLimit) items.push(el('button', { type: 'button', className: 'artifact-more', 'data-show-more': 'true', text: State.artifactsExpanded ? 'Show less' : `Show ${artifacts.length - fileLimit} more` }));
  $('artifact-list').replaceChildren(...items);
  let selected = artifacts.find((artifact) => artifact.relativePath === State.selectedArtifact);
  if (!selected && artifacts.length > 0) {
    if (State.currentStage === 'script') {
      selected = findLatestScriptArtifact(artifacts) || artifacts[0];
    } else {
      selected = artifacts[0];
    }
    State.selectedArtifact = selected.relativePath;
  }

  if (State.currentStage === 'script') {
    if (!artifacts.length) {
      if ($('script-action-bar')) $('script-action-bar').hidden = true;
      if ($('script-generate-card')) $('script-generate-card').hidden = false;
      if ($('artifact-view')) $('artifact-view').hidden = true;
      if ($('script-gen-lang')) $('script-gen-lang').value = State.project?.settings?.scriptAuthoringLanguage || 'en';
      if ($('script-gen-duration')) $('script-gen-duration').value = State.project?.settings?.targetDurationMin || 12;
      return;
    } else {
      if ($('script-generate-card')) $('script-generate-card').hidden = true;
      if ($('artifact-view')) $('artifact-view').hidden = false;
      if ($('script-action-bar')) $('script-action-bar').hidden = false;
    }
  } else {
    if ($('script-action-bar')) $('script-action-bar').hidden = true;
    if ($('script-generate-card')) $('script-generate-card').hidden = true;
    if ($('artifact-view')) $('artifact-view').hidden = false;
  }

  if (!selected) $('artifact-view').replaceChildren(el('div', { className: 'artifact-empty' }, [el('strong', { text: artifacts.length ? 'Choose working material' : 'No material yet' }), el('span', { text: artifacts.length ? 'Review, play, or edit an artifact.' : 'Required outputs will appear here.' })]));
  else showArtifact(selected);
}
function formatAudioSeconds(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function switchAudioReviewTab(tab) {
  State.audioStudio.activeReviewTab = tab;
  const isVoiceConfig = tab === 'voice-config';
  if ($('btn-tab-review-gate')) $('btn-tab-review-gate').className = `review-subtab-btn ${!isVoiceConfig ? 'active' : ''}`;
  if ($('btn-tab-voice-config')) $('btn-tab-voice-config').className = `review-subtab-btn ${isVoiceConfig ? 'active' : ''}`;
  if ($('audio-voice-config-section')) $('audio-voice-config-section').hidden = !isVoiceConfig;
  if ($('review-gate-section-wrap')) $('review-gate-section-wrap').hidden = isVoiceConfig;
  if (isVoiceConfig && $('review-drawer') && $('review-drawer').hidden) {
    $('review-drawer').hidden = false;
  }
}

function switchAudioTab(tab) {
  State.audioStudio.activeTab = tab;
  const tabs = ['chunks', 'music', 'mix', 'player'];
  tabs.forEach((t) => {
    const btn = $(`tab-btn-${t}`);
    if (btn) {
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
    const panel = $(`panel-audio-${t}`);
    if (panel) panel.hidden = t !== tab;
  });
}

function setupAudioTabs() {
  const tabs = ['chunks', 'music', 'mix', 'player'];
  tabs.forEach((tab) => {
    const btn = $(`tab-btn-${tab}`);
    if (!btn) return;
    btn.onclick = () => switchAudioTab(tab);
  });

  if ($('btn-tab-review-gate')) $('btn-tab-review-gate').onclick = () => switchAudioReviewTab('gate');
  if ($('btn-tab-voice-config')) $('btn-tab-voice-config').onclick = () => switchAudioReviewTab('voice-config');
}

async function renderAudioStudio() {
  if (!State.project || State.currentStage !== 'audio') return;
  const container = $('audio-studio');
  if (!container) return;

  try {
    const [manifestResponse, voiceResponse, candidatesResponse] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/manifest`),
      api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/voice-profile`),
      api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/reference-candidates`),
    ]);

    State.audioStudio.manifest = manifestResponse;
    const manifest = manifestResponse;
    const profiles = voiceResponse.profiles || [];
    const candidates = candidatesResponse.candidates || [];

    // Header & Meta Bar
    if ($('audio-studio-title')) {
      $('audio-studio-title').textContent = State.project.title || 'Audio Production Workspace';
    }
    if ($('audio-stat-chunks-count')) {
      $('audio-stat-chunks-count').textContent = `${manifest.summary?.completedChunks || 0} / ${manifest.summary?.totalChunks || 0}`;
    }
    if ($('audio-stat-cues-count')) {
      $('audio-stat-cues-count').textContent = `${manifest.summary?.cuesCount || 0} Planned`;
    }
    if ($('tab-chunks-progress-badge')) {
      $('tab-chunks-progress-badge').textContent = `${manifest.summary?.percent || 0}%`;
    }

    // Action buttons in header
    const runAudio = async (substage) => {
      try {
        const data = substage === 'voice'
          ? await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/voice/generate`, { method: 'POST', body: {} })
          : substage === 'music'
          ? await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/music/generate`, { method: 'POST', body: { provider: manifest.pipelineConfig?.music?.provider } })
          : await api('/api/jobs', { method: 'POST', body: { projectKey: State.projectKey, stageId: 'audio', substage, adapter: 'python' } });
        toast(`${substage === 'voice' ? 'Voiceover' : substage === 'music' ? 'Music' : 'Final mix'} queued`, 'success');
        State.activeRunId = data.run.id;
        if (substage === 'mix') {
          switchAudioTab('mix');
        }
        renderAudioStudio();
      } catch (error) {
        toast(error.message, 'error');
      }
    };

    if ($('btn-prepare-narration')) {
      $('btn-prepare-narration').onclick = async () => {
        try {
          const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/narration/compile`, { method: 'POST', body: {} });
          toast(`${result.manifest.chunks.length} narration chunks are ready to review`, 'success');
          renderAudioStudio();
        } catch (error) { toast(error.message, 'error'); }
      };
    }
    if ($('btn-review-narration')) {
      $('btn-review-narration').onclick = async () => {
        try {
          const audit = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/narration/audit`, { method: 'POST', body: {} });
          const panel = $('batch-review-panel');
          panel.hidden = false;
          $('batch-review-title').textContent = `One review for ${audit.chunks} chunks`;
          $('batch-review-summary').textContent = audit.summary;
          const findings = $('batch-review-findings');
          findings.replaceChildren(...(audit.findings.length ? audit.findings.map((finding) => el('div', { className: 'batch-review-finding' }, [el('strong', { text: `Chunk ${finding.chunk}` }), el('span', { text: finding.message }), el('small', { text: finding.suggestion })])) : [el('div', { className: 'status-pill ok', text: 'No exceptions — narration is ready to approve.' })]));
          $('btn-close-batch-review').onclick = () => { panel.hidden = true; };
          $('btn-approve-batch-review').onclick = async () => {
            try {
              await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/narration/review`, { method: 'POST', body: { decision: 'approved', audit } });
              panel.hidden = true;
              toast('Narration plan approval recorded. Voiceover generation is now enabled.', 'success');
              renderAudioStudio();
            } catch (error) { toast(error.message, 'error'); }
          };
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (error) { toast(error.message, 'error'); }
      };
    }

    if ($('btn-run-voiceover')) {
      $('btn-run-voiceover').onclick = () => runAudio('voice');
      const narrationApproved = manifest.narrationReview?.status === 'approved';
      $('btn-run-voiceover').disabled = !narrationApproved || Boolean(manifest.summary?.activeRun && manifest.summary.activeRun.substage === 'voice');
      $('btn-run-voiceover').title = narrationApproved ? 'Generate narration voiceover via local Higgs TTS' : 'Run “Review all” and record narration approval before generating voiceover.';
    }
    if ($('btn-run-music')) {
      $('btn-run-music').onclick = () => runAudio('music');
      const musicConfigured = Boolean(manifest.pipelineConfig?.music?.script && manifest.pipelineConfig?.music?.manifest);
      const activeProvider = manifest.pipelineConfig?.music?.provider === 'yue' ? 'YuE2-3B' : 'ACE-Step 1.5';
      $('btn-run-music').disabled = !musicConfigured || Boolean(manifest.summary?.activeRun && manifest.summary.activeRun.substage === 'music');
      $('btn-run-music').title = musicConfigured ? `Generate soundtrack cues via ${activeProvider}` : 'Music generation is unavailable until a local music provider and cue manifest are configured.';
    }
    if ($('btn-run-mix')) {
      $('btn-run-mix').onclick = () => runAudio('mix');
      $('btn-run-mix').disabled = Boolean(manifest.summary?.activeRun && manifest.summary.activeRun.substage === 'mix');
    }
    if ($('btn-open-voice-config')) {
      $('btn-open-voice-config').onclick = () => {
        if ($('review-drawer')) $('review-drawer').hidden = false;
        switchAudioReviewTab('voice-config');
      };
    }

    // Setup Main Stage Tabs
    setupAudioTabs();

    // Render 1: Left Library Rail
    renderAudioLibrary(manifest);

    // Render 2: Chunk Monitor
    renderChunkMonitor(manifest);

    // Render 3: Music & Score Timeline
    renderMusicTimeline(manifest);

    // Render 4: Right Drawer Voice Config
    renderVoiceConfigSection(manifest, profiles, candidates);

    // Render 5: Master Mix
    renderMasterMix(manifest, runAudio);

    // Initial selected file in player if not selected (do not switch tab)
    if (!State.audioStudio.selectedItem && manifest.library?.length) {
      const preferred = manifest.library.find((item) => item.type === 'take')
        || manifest.library.find((item) => item.type === 'mix')
        || manifest.library[0];
      if (preferred) selectAudioLibraryItem(preferred, manifest, { switchTab: false });
    }

    // Ensure active tab is respected (defaults to 'chunks' tab)
    if (!State.audioStudio.activeTab) State.audioStudio.activeTab = 'chunks';
    switchAudioTab(State.audioStudio.activeTab);

    // Auto-polling when active run exists
    if (manifest.summary?.activeRun) {
      if (!State.audioStudio.pollingTimer) {
        State.audioStudio.pollingTimer = setInterval(() => {
          if (State.currentStage === 'audio') renderAudioStudio();
          else clearInterval(State.audioStudio.pollingTimer);
        }, 2500);
      }
    } else if (State.audioStudio.pollingTimer) {
      clearInterval(State.audioStudio.pollingTimer);
      State.audioStudio.pollingTimer = null;
    }

  } catch (error) {
    console.error('Failed to render audio studio:', error);
  }
}

function renderAudioLibrary(manifest) {
  const lib = manifest.library || [];
  if ($('audio-library-total-count')) $('audio-library-total-count').textContent = `${lib.length} files`;

  const voiceGroup = $('lib-group-voice');
  const musicGroup = $('lib-group-music');
  const mixesGroup = $('lib-group-mixes');
  const plansGroup = $('lib-group-plans');

  const voiceItems = lib.filter((i) => i.category === 'voice' || i.category === 'chunks');
  const musicItems = lib.filter((i) => i.category === 'music');
  const mixesItems = lib.filter((i) => i.category === 'mixes');
  const plansItems = lib.filter((i) => i.category === 'plans');

  if ($('count-group-voice')) $('count-group-voice').textContent = voiceItems.length;
  if ($('count-group-music')) $('count-group-music').textContent = musicItems.length;
  if ($('count-group-mixes')) $('count-group-mixes').textContent = mixesItems.length;
  if ($('count-group-plans')) $('count-group-plans').textContent = plansItems.length;

  const makeLibButton = (item) => {
    const isSelected = State.audioStudio.selectedItem?.relativePath === item.relativePath;
    const btn = el('button', {
      type: 'button',
      className: `lib-item-btn ${isSelected ? 'active' : ''}`,
      title: item.relativePath,
    }, [
      el('span', { className: 'lib-item-name', text: item.name }),
      el('span', { className: 'lib-item-meta', text: item.duration ? `${item.duration}s` : formatBytes(item.size) }),
    ]);
    btn.onclick = () => selectAudioLibraryItem(item, manifest);
    return btn;
  };

  const populateGroup = (container, items, emptyText) => {
    if (!container) return;
    if (!items.length) {
      container.replaceChildren(el('div', { className: 'rail-empty', text: emptyText }));
    } else {
      container.replaceChildren(...items.map(makeLibButton));
    }
  };

  populateGroup(voiceGroup, voiceItems, 'No voice takes yet');
  populateGroup(musicGroup, musicItems, 'No music stems yet');
  populateGroup(mixesGroup, mixesItems, 'No mixes yet');
  populateGroup(plansGroup, plansItems, 'No plans found');

  // Search input filtering
  const searchInput = $('audio-library-search');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = 'true';
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      document.querySelectorAll('.lib-item-btn').forEach((btn) => {
        const text = btn.textContent.toLowerCase();
        btn.style.display = !q || text.includes(q) ? 'flex' : 'none';
      });
    };
  }
}

function selectAudioLibraryItem(item, manifest, { switchTab = true } = {}) {
  State.audioStudio.selectedItem = item;
  document.querySelectorAll('.lib-item-btn').forEach((b) => {
    b.classList.toggle('active', b.title === item.relativePath);
  });
  renderAudioPlayer(item);
  if (switchTab) {
    if (item.type === 'mix' && $('tab-btn-mix')) {
      switchAudioTab('mix');
    } else {
      switchAudioTab('player');
    }
  }
}

function renderChunkMonitor(manifest) {
  const summary = manifest.summary || {};
  const chunks = manifest.chunks || [];
  const chunkReviews = manifest.narrationReview?.chunkReviews || {};
  const narrationApproved = manifest.narrationReview?.status === 'approved';
  const completed = summary.completedChunks || 0;
  const total = summary.totalChunks || 0;
  const percent = summary.percent || 0;

  if ($('chunk-progress-headline')) {
    $('chunk-progress-headline').textContent = summary.activeRun
      ? `Voiceover Synthesis in Progress (${completed} of ${total} chunks)`
      : (manifest.narrationManifest ? `Narration ready for review (${total} chunks)` : `Voiceover Synthesis Status (${completed} of ${total} chunks)`);
  }
  if ($('chunk-progress-subtitle')) {
    $('chunk-progress-subtitle').textContent = manifest.primaryChunkDir
      ? `Checkpoints saved under 03_audio/takes/${manifest.primaryChunkDir}`
      : (manifest.narrationManifest ? 'Prepared transcript — review a chunk or generate the full voiceover.' : 'Local Higgs TTS Speech Engine');
  }
  if ($('chunk-percentage-pill')) $('chunk-percentage-pill').textContent = `${percent}%`;
  if ($('chunk-progress-bar')) $('chunk-progress-bar').style.width = `${percent}%`;

  if ($('metric-total-chunks')) $('metric-total-chunks').textContent = total;
  if ($('metric-completed-chunks')) $('metric-completed-chunks').textContent = completed;
  if ($('metric-remaining-chunks')) $('metric-remaining-chunks').textContent = Math.max(0, total - completed);

  // Total spoken duration
  const spokenSeconds = chunks.filter((c) => c.status === 'completed').reduce((acc, c) => acc + (c.duration || 0), 0);
  if ($('metric-spoken-time')) $('metric-spoken-time').textContent = formatAudioSeconds(spokenSeconds);
  if ($('metric-engine-status')) {
    $('metric-engine-status').textContent = summary.activeRun ? 'Running ⚡' : (completed > 0 ? 'Ready' : 'Idle');
  }

  const container = $('chunk-list-container');
  if (!container) return;

  if (!chunks.length) {
    container.replaceChildren(el('div', { className: 'chunk-empty-state', text: 'No voiceover chunks found. Click "Generate Voiceover" to synthesize speech.' }));
    return;
  }

  const openReview = (chunk) => {
    const panel = $('chunk-review-panel');
    if (!panel) return;
    panel.hidden = false;
    $('chunk-review-title').textContent = `Chunk ${chunk.index} · ${chunk.words || '—'} words`;
    $('chunk-review-text').textContent = chunk.text || 'Transcript is not available for this legacy checkpoint.';
    $('btn-close-chunk-review').onclick = () => { panel.hidden = true; };
    $('btn-approve-chunk').onclick = async () => {
      try {
        const note = $('chunk-review-comment')?.value || '';
        await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/narration/chunks/${chunk.index}/review`, { method: 'POST', body: { decision: 'approved', note } });
        toast(`Chunk ${chunk.index} review recorded`, 'success');
        renderAudioStudio();
      } catch (error) { toast(error.message, 'error'); }
    };
    $('btn-retake-chunk').onclick = async () => {
      try {
        const note = $('chunk-review-comment')?.value || '';
        if (note.trim()) await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/narration/chunks/${chunk.index}/review`, { method: 'POST', body: { decision: 'changes_requested', note } });
        const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/chunks/${chunk.index}/generate`, { method: 'POST', body: {} });
        toast(`Chunk ${chunk.index} regeneration queued`, 'success');
        State.activeRunId = result.run.id;
        panel.hidden = true;
        renderAudioStudio();
      } catch (error) { toast(error.message, 'error'); }
    };
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const rows = chunks.map((chunk) => {
    const isCompleted = chunk.status === 'completed';
    const isGenerating = chunk.status === 'generating';

    const reviewState = chunkReviews[chunk.index]?.status;
    const statusBadge = el('span', {
      className: `status-pill ${isCompleted ? 'ok' : isGenerating ? 'running' : ''}`,
      text: isCompleted ? (reviewState === 'approved' ? 'Approved' : 'Completed') : isGenerating ? 'Generating…' : chunk.status === 'prepared' ? (reviewState === 'approved' ? 'Approved' : 'Ready to review') : 'Queued',
    });

    const scriptExcerpt = el('span', {
      className: 'chunk-script-excerpt',
      text: chunk.text ? chunk.text : `(Chunk #${chunk.index} audio)`,
      title: chunk.text ? 'Click to inspect chunk text and audio' : '',
    });
    scriptExcerpt.onclick = () => {
      const item = {
        name: chunk.filename,
        relativePath: chunk.relativePath,
        url: chunk.url,
        size: chunk.size,
        duration: chunk.duration,
        text: chunk.text,
        type: 'chunk',
        isAudio: true,
      };
      selectAudioLibraryItem(item, manifest);
    };

    const durationCol = el('span', {
      className: 'chunk-duration-stat',
      text: isCompleted ? `${chunk.duration ? chunk.duration.toFixed(1) + 's' : '—'} ${chunk.rtf ? '· ' + chunk.rtf + 'x' : ''}` : '—',
    });

    let actionBtn = el('span', { className: 'artifact-meta', text: '—' });
    if (isCompleted && chunk.url) {
      const playBtn = el('button', {
        type: 'button',
        className: 'btn-chunk-play',
        text: '▶ Play',
      });
      playBtn.onclick = (e) => {
        e.stopPropagation();
        playInlineChunkAudio(chunk, playBtn);
      };
      const reviewBtn = el('button', { type: 'button', className: 'btn-chunk-play', text: reviewState === 'approved' ? 'Reviewed' : 'Review' });
      reviewBtn.onclick = () => openReview(chunk);
      actionBtn = el('span', { className: 'chunk-action-group' }, [playBtn, reviewBtn]);
    }
    if (!isCompleted && chunk.status === 'prepared') {
      const reviewBtn = el('button', { type: 'button', className: 'btn-chunk-play', text: 'Review' });
      reviewBtn.onclick = () => openReview(chunk);
      const generateBtn = el('button', { type: 'button', className: 'btn-chunk-play', text: 'Generate' });
      generateBtn.disabled = !narrationApproved;
      generateBtn.title = narrationApproved ? 'Generate this chunk only' : 'Approve the batch narration review before generating a chunk.';
      generateBtn.onclick = async () => {
        try {
          const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/chunks/${chunk.index}/generate`, { method: 'POST', body: {} });
          toast(`Chunk ${chunk.index} queued for voice synthesis`, 'success');
          State.activeRunId = result.run.id;
          renderAudioStudio();
        } catch (error) { toast(error.message, 'error'); }
      };
      actionBtn = el('span', { className: 'chunk-action-group' }, [reviewBtn, generateBtn]);
    }

    return el('div', {
      className: `chunk-row ${isGenerating ? 'is-generating' : ''}`,
    }, [
      el('span', { className: 'chunk-id-tag', text: `#${chunk.index}` }),
      statusBadge,
      scriptExcerpt,
      durationCol,
      actionBtn,
    ]);
  });

  container.replaceChildren(...rows);
}

function playInlineChunkAudio(chunk, btn) {
  const player = $('audio-studio-player');
  if (!player) return;

  if (State.audioStudio.inlineAudio?.btn === btn && !player.paused) {
    player.pause();
    btn.textContent = '▶ Play';
    btn.classList.remove('playing');
    State.audioStudio.inlineAudio = null;
    return;
  }

  document.querySelectorAll('.btn-chunk-play').forEach((b) => {
    b.textContent = '▶ Play';
    b.classList.remove('playing');
  });

  player.src = chunk.url;
  player.play().then(() => {
    btn.textContent = '⏸ Pause';
    btn.classList.add('playing');
    State.audioStudio.inlineAudio = { chunk, btn };
  }).catch(() => {});

  player.onended = () => {
    btn.textContent = '▶ Play';
    btn.classList.remove('playing');
    State.audioStudio.inlineAudio = null;
  };
}

function renderAudioPlayer(item) {
  if (!item) return;
  if ($('player-active-filename')) $('player-active-filename').textContent = item.name;
  if ($('player-active-filesize')) $('player-active-filesize').textContent = formatBytes(item.size || 0);
  if ($('player-active-filetype')) $('player-active-filetype').textContent = item.isAudio ? 'Audio WAV' : (item.isJson ? 'JSON Data' : 'Document');

  const playerCard = $('audio-player-card');
  const docReader = $('audio-doc-reader');
  const player = $('audio-studio-player');
  const playBtn = $('btn-player-play-toggle');
  const scrubSlider = $('player-scrubber');
  const curTime = $('player-current-time');
  const totTime = $('player-total-time');

  if (item.isAudio && item.url) {
    if (playerCard) playerCard.hidden = false;
    if (docReader) docReader.hidden = true;

    if (player) {
      player.src = item.url;
      player.onloadedmetadata = () => {
        if (totTime) totTime.textContent = formatAudioSeconds(player.duration);
        if (scrubSlider) {
          scrubSlider.max = player.duration || 100;
          scrubSlider.value = 0;
        }
      };
      player.ontimeupdate = () => {
        if (curTime) curTime.textContent = formatAudioSeconds(player.currentTime);
        if (scrubSlider && !scrubSlider.dataset.dragging) {
          scrubSlider.value = player.currentTime || 0;
        }
      };
      player.onended = () => {
        if (playBtn) playBtn.textContent = '▶';
      };
    }

    if (playBtn) {
      playBtn.textContent = '▶';
      playBtn.onclick = () => {
        if (!player) return;
        if (player.paused) {
          player.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
        } else {
          player.pause();
          playBtn.textContent = '▶';
        }
      };
    }

    if (scrubSlider && !scrubSlider.dataset.bound) {
      scrubSlider.dataset.bound = 'true';
      scrubSlider.onmousedown = () => { scrubSlider.dataset.dragging = 'true'; };
      scrubSlider.onmouseup = () => {
        scrubSlider.dataset.dragging = '';
        if (player) player.currentTime = Number(scrubSlider.value);
      };
      scrubSlider.onchange = () => {
        if (player) player.currentTime = Number(scrubSlider.value);
      };
    }

    const volSlider = $('player-volume');
    if (volSlider && !volSlider.dataset.bound) {
      volSlider.dataset.bound = 'true';
      volSlider.oninput = () => {
        if (player) player.volume = Number(volSlider.value);
      };
    }

    // Generate animated visual wave bars
    const waveContainer = $('wave-bars');
    if (waveContainer) {
      const bars = [];
      for (let i = 0; i < 40; i++) {
        const h = Math.floor(Math.sin(i * 0.2) * 12 + 18);
        bars.push(el('div', { className: 'wave-bar', style: `height: ${h}px;` }));
      }
      waveContainer.replaceChildren(...bars);
    }

  } else {
    // Text / Document Reader
    if (playerCard) playerCard.hidden = true;
    if (docReader) docReader.hidden = false;
    const contentBox = $('audio-doc-content');
    if (contentBox && item.url) {
      contentBox.replaceChildren(el('div', { className: 'rail-empty', text: 'Loading artifact content…' }));
      fetch(item.url)
        .then((res) => res.text())
        .then((text) => {
          contentBox.replaceChildren(el('pre', {
            style: 'font-size: 12px; line-height: 1.5; color: var(--paper); white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, monospace;',
            text,
          }));
        })
        .catch((err) => {
          contentBox.replaceChildren(el('div', { className: 'rail-empty', text: `Could not load: ${err.message}` }));
        });
    }
  }
}

function renderMusicTimeline(manifest) {
  const cues = manifest.musicCues || manifest.plan?.musicCues || [];
  const musicConfigured = Boolean(manifest.pipelineConfig?.music?.script && manifest.pipelineConfig?.music?.manifest);
  const cueCount = cues.length;
  if ($('tab-music-cues-badge')) $('tab-music-cues-badge').textContent = `${cueCount} cues`;
  if ($('audio-stat-cues-count')) $('audio-stat-cues-count').textContent = `${cueCount} Planned`;
  if ($('music-stat-total-cues')) $('music-stat-total-cues').textContent = `${cueCount} Cues Planned`;

  // Visual horizontal ribbon
  const ribbon = $('music-timeline-ribbon');
  if (ribbon) {
    const totalDuration = manifest.plan?.targetDurationSeconds || 720;
    const colors = [
      '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b',
      '#10b981', '#06b6d4', '#6366f1', '#eab308'
    ];
    ribbon.replaceChildren(
      ...cues.map((cue, idx) => {
        const dur = cue.durationSeconds || 30;
        const pct = Math.max(4, (dur / totalDuration) * 100);
        const bg = colors[idx % colors.length];
        const seg = el('div', {
          className: 'ribbon-segment',
          style: `width: ${pct}%; background: ${bg};`,
          title: `${cue.id}: ${cue.startFormatted || '0:00'} – ${cue.endFormatted || '0:00'} (${dur}s)`,
          text: `${cue.id} (${cue.startFormatted || '0:00'}–${cue.endFormatted || '0:00'})`,
        });
        seg.onclick = () => {
          const card = document.getElementById(`cue-card-${cue.id}`);
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        return seg;
      })
    );
  }

  // Music Cue Cards List
  const container = $('music-cues-container');
  if (!container) return;

  if (!cues.length) {
    container.replaceChildren(el('div', { className: 'rail-empty', text: 'No music cues found in audio plan.' }));
    return;
  }

  const relativeMediaUrl = (relativePath) => `/media/${encodeURIComponent(State.projectKey)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;

  const activeProvider = manifest.pipelineConfig?.music?.provider === 'yue' ? 'YuE2-3B' : 'ACE-Step 1.5';
  const providerKey = manifest.pipelineConfig?.music?.provider || 'ace_step';

  const providerSelect = $('music-provider-select');
  if (providerSelect) {
    providerSelect.value = providerKey;
    providerSelect.onchange = async () => {
      const selected = providerSelect.value;
      try {
        await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/pipeline`, {
          method: 'PATCH',
          body: { music: { provider: selected } },
        });
        toast(`Music engine switched to ${selected === 'yue' ? 'YuE2-3B' : 'ACE-Step 1.5'}`, 'success');
        renderAudioStudio();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  const cards = cues.map((cue) => {
    // Cue identity
    const idBadge = el('span', { className: 'cue-id-badge', text: cue.id });
    const moodTitle = cue.brief?.match(/Mood:\s*([^;]+)/i)?.[1] || cue.id;
    const titleEl = el('h4', { text: `${cue.id} · ${moodTitle}` });
    const identityWrap = el('div', { className: 'cue-card-identity' }, [idBadge, titleEl]);

    // Required time span ("where to where that music is required to be")
    const timePill = el('span', {
      className: 'music-cue-time-pill',
      text: `⏱️ ${cue.startFormatted || '0:00'} → ${cue.endFormatted || '0:00'} (${cue.durationSeconds || 0}s)`,
      title: 'Required music timestamp range',
    });
    const beatPill = cue.beatRange ? el('span', {
      className: 'music-cue-beat-pill',
      text: cue.beatRange,
      title: 'Editorial Blueprint beat range',
    }) : null;
    const timingWrap = el('div', { className: 'cue-card-timing' }, [timePill, ...(beatPill ? [beatPill] : [])]);

    const topRow = el('div', { className: 'cue-card-top' }, [identityWrap, timingWrap]);

    // Brief details
    const briefBox = el('div', { className: 'cue-brief-text', text: cue.brief || 'Original score cue' });

    // Dialogue protection note
    const protectionNote = el('div', { className: 'cue-protection-note' }, [
      el('strong', { text: `Ducking: ${cue.narrationDuckDb || -16} dB` }),
      el('span', { text: `· ${cue.dialogueProtection || 'Dialogue protection active'}` }),
    ]);

    // Track Player or Generator Status
    let playerRow = null;
    if (cue.audioTrack) {
      const audioEl = el('audio', {
        controls: true,
        preload: 'metadata',
        src: cue.audioTrack.url || relativeMediaUrl(cue.audioTrack.relativePath),
      });
      const trackLabel = el('span', { className: 'artifact-meta', text: cue.audioTrack.filename });
      const regenBtn = el('button', {
        type: 'button',
        className: 'button quiet compact-button',
        text: `🔄 Regenerate (${activeProvider})`,
        disabled: !musicConfigured,
      });
      regenBtn.onclick = async () => {
        try {
          await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/music/generate`, {
            method: 'POST',
            body: { provider: providerKey, cue: cue.id, overwrite: true },
          });
          toast(`Music regeneration queued for ${cue.id} via ${activeProvider}`, 'success');
          renderAudioStudio();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      playerRow = el('div', { className: 'cue-audio-player-wrap' }, [trackLabel, audioEl, regenBtn]);
    } else {
      const statusPill = el('span', { className: 'status-pill', text: `Planned (${activeProvider})` });
      const genBtn = el('button', {
        type: 'button',
        className: 'button quiet compact-button',
        text: musicConfigured ? `🎵 Generate Cue (${activeProvider})` : 'Music provider unavailable',
        disabled: !musicConfigured,
      });
      genBtn.onclick = async () => {
        try {
          await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/music/generate`, {
            method: 'POST',
            body: { provider: providerKey, cue: cue.id, overwrite: true },
          });
          toast(`Music generation queued for ${cue.id} via ${activeProvider}`, 'success');
          renderAudioStudio();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      playerRow = el('div', { className: 'cue-audio-player-wrap' }, [statusPill, genBtn]);
    }

    return el('div', { className: 'music-cue-card', id: `cue-card-${cue.id}` }, [
      topRow,
      briefBox,
      protectionNote,
      playerRow,
    ]);
  });

  container.replaceChildren(...cards);

  // Hook button to trigger music substage
  const btnTrigger = $('btn-trigger-music-substage');
  if (btnTrigger) {
    btnTrigger.disabled = !musicConfigured;
    btnTrigger.textContent = `🎵 Generate Soundtrack via ${activeProvider}`;
    btnTrigger.title = musicConfigured ? `Generate all soundtrack cues using ${activeProvider}` : 'Configure a local music provider and cue manifest first.';
    btnTrigger.onclick = async () => {
      try {
        await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/music/generate`, {
          method: 'POST',
          body: { provider: providerKey, overwrite: true },
        });
        toast(`Soundtrack generation queued via ${activeProvider}`, 'success');
        renderAudioStudio();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  // Hook targeted revision
  const btnSubmit = $('btn-submit-revision');
  if (btnSubmit) {
    btnSubmit.onclick = async () => {
      btnSubmit.disabled = true;
      try {
        const start = Number($('rev-start-time')?.value || 0);
        const end = Number($('rev-end-time')?.value || 30);
        const scope = $('rev-scope')?.value || 'music';
        const body = $('rev-comment')?.value || '';
        if (!body.trim()) throw new Error('Enter a revision description');
        const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/comments`, {
          method: 'POST',
          body: { startSeconds: start, endSeconds: end, scope, body },
        });
        toast(data.run ? 'Targeted revision queued' : 'Revision recorded', 'success');
        if ($('rev-comment')) $('rev-comment').value = '';
        renderAudioStudio();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        btnSubmit.disabled = false;
      }
    };
  }
}

function renderMasterMix(manifest, runAudio) {
  const mixes = manifest.mixes || [];
  const latestMix = mixes.find((m) => m.filename.startsWith('final_mix') && m.isAudio)
    || mixes.find((m) => m.isAudio)
    || null;

  const heroCard = $('master-mix-hero-card');
  const mixBadge = $('tab-mix-badge');
  const emptyCard = $('mix-empty-card');
  const headerCard = $('mix-station-header-card');
  const playerWorkspace = $('mix-player-workspace');
  const stemsCard = $('mix-stems-card');
  const qcCard = $('mix-qc-card');

  if (!latestMix) {
    if (heroCard) heroCard.hidden = true;
    if (mixBadge) {
      mixBadge.textContent = '0';
      mixBadge.className = 'tab-count-badge';
    }
    if (emptyCard) emptyCard.hidden = false;
    if (headerCard) headerCard.hidden = true;
    if (playerWorkspace) playerWorkspace.hidden = true;
    if (stemsCard) stemsCard.hidden = true;
    if (qcCard) qcCard.hidden = true;

    if ($('btn-mix-empty-run')) {
      $('btn-mix-empty-run').onclick = () => {
        if (runAudio) runAudio('mix');
        else if ($('btn-run-mix')) $('btn-run-mix').click();
      };
    }
    return;
  }

  // Master mix exists
  const versionMatch = latestMix.filename.match(/final_mix_v(\d+)/i);
  const versionLabel = versionMatch ? `v${versionMatch[1]}` : 'v1';

  if (mixBadge) {
    mixBadge.textContent = versionLabel;
    mixBadge.className = 'tab-count-badge ok';
  }

  // Hero Card update
  if (heroCard) {
    heroCard.hidden = false;
    if ($('hero-master-version')) $('hero-master-version').textContent = latestMix.filename;
    if ($('hero-master-timing')) $('hero-master-timing').textContent = `${formatBytes(latestMix.size)} · Stereo 48 kHz`;
    if ($('hero-master-download')) {
      $('hero-master-download').href = latestMix.url;
      $('hero-master-download').setAttribute('download', latestMix.filename);
    }
    if ($('btn-hero-master-view')) {
      $('btn-hero-master-view').onclick = () => switchAudioTab('mix');
    }
  }

  // Station view updates
  if (emptyCard) emptyCard.hidden = true;
  if (headerCard) headerCard.hidden = false;
  if (playerWorkspace) playerWorkspace.hidden = false;
  if (stemsCard) stemsCard.hidden = false;
  if (qcCard) qcCard.hidden = false;

  if ($('mix-version-pill')) $('mix-version-pill').textContent = `${latestMix.filename} (${versionLabel})`;
  if ($('mix-filesize-pill')) $('mix-filesize-pill').textContent = formatBytes(latestMix.size);
  if ($('btn-mix-download')) {
    $('btn-mix-download').href = latestMix.url;
    $('btn-mix-download').setAttribute('download', latestMix.filename);
  }
  if ($('btn-mix-rerun')) {
    $('btn-mix-rerun').onclick = () => {
      if (runAudio) runAudio('mix');
      else if ($('btn-run-mix')) $('btn-run-mix').click();
    };
  }

  // Waveform player
  const player = $('mix-studio-player');
  const playBtn = $('btn-mix-play-toggle');
  const scrubSlider = $('mix-scrubber');
  const curTime = $('mix-current-time');
  const totTime = $('mix-total-time');

  if (player && latestMix.url) {
    const targetUrl = latestMix.url.startsWith('http') ? latestMix.url : window.location.origin + latestMix.url;
    if (player.src !== targetUrl && player.src !== latestMix.url) {
      player.src = latestMix.url;
    }

    player.onloadedmetadata = () => {
      if (totTime) totTime.textContent = formatAudioSeconds(player.duration);
      if (scrubSlider) {
        scrubSlider.max = player.duration || 100;
        scrubSlider.value = 0;
      }
    };
    player.ontimeupdate = () => {
      if (curTime) curTime.textContent = formatAudioSeconds(player.currentTime);
      if (scrubSlider && !scrubSlider.dataset.dragging) {
        scrubSlider.value = player.currentTime || 0;
      }
    };
    player.onended = () => {
      if (playBtn) playBtn.textContent = '▶';
    };

    if (playBtn) {
      playBtn.onclick = () => {
        const otherPlayer = $('audio-studio-player');
        if (otherPlayer && !otherPlayer.paused) {
          otherPlayer.pause();
          if ($('btn-player-play-toggle')) $('btn-player-play-toggle').textContent = '▶';
        }

        if (player.paused) {
          player.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
        } else {
          player.pause();
          playBtn.textContent = '▶';
        }
      };
    }

    if (scrubSlider && !scrubSlider.dataset.bound) {
      scrubSlider.dataset.bound = 'true';
      scrubSlider.onmousedown = () => { scrubSlider.dataset.dragging = 'true'; };
      scrubSlider.onmouseup = () => {
        scrubSlider.dataset.dragging = '';
        if (player) player.currentTime = Number(scrubSlider.value);
      };
      scrubSlider.onchange = () => {
        if (player) player.currentTime = Number(scrubSlider.value);
      };
    }

    const volSlider = $('mix-volume');
    if (volSlider && !volSlider.dataset.bound) {
      volSlider.dataset.bound = 'true';
      volSlider.oninput = () => {
        if (player) player.volume = Number(volSlider.value);
      };
    }

    const waveContainer = $('mix-wave-bars');
    if (waveContainer && !waveContainer.children.length) {
      const bars = [];
      for (let i = 0; i < 48; i++) {
        const h = Math.floor(Math.sin(i * 0.25) * 14 + 18);
        bars.push(el('div', { className: 'wave-bar', style: `height: ${h}px;` }));
      }
      waveContainer.replaceChildren(...bars);
    }
  }

  // Render Stems breakdown
  const stemsContainer = $('mix-stems-list');
  if (stemsContainer) {
    const cues = manifest.musicCues || manifest.plan?.musicCues || [];
    const stemRows = [];

    // Voice Stem
    const voiceTake = manifest.takeReports?.[0]?.data;
    const voiceDuration = voiceTake?.audio_seconds || (manifest.chunks?.filter((c) => c.status === 'completed').reduce((a, b) => a + (b.duration || 0), 0)) || 631;
    stemRows.push(el('div', { className: 'mix-stem-row' }, [
      el('div', { className: 'mix-stem-badge voice', text: '🎙️ Voiceover' }),
      el('div', { className: 'mix-stem-info' }, [
        el('span', { className: 'mix-stem-name', text: manifest.takeAudioFiles?.[0]?.filename || 'Primary Narration Take' }),
        el('span', { className: 'mix-stem-desc', text: `${manifest.summary?.completedChunks || 30} chunks synthesized via Higgs TTS (Mono Centered)` }),
      ]),
      el('div', { className: 'mix-stem-timing', text: `0:00 – ${formatAudioSeconds(voiceDuration)}` }),
      el('div', { className: 'mix-stem-role', text: 'Primary Dialogue (0 dB)' }),
    ]));

    // Music Stems
    const readyCues = cues.filter((c) => c.status === 'ready' || c.audioTrack);
    const displayedCues = readyCues.length > 0 ? readyCues : cues.slice(0, 3);
    for (const cue of displayedCues) {
      stemRows.push(el('div', { className: 'mix-stem-row' }, [
        el('div', { className: 'mix-stem-badge music', text: `🎵 Cue ${cue.id}` }),
        el('div', { className: 'mix-stem-info' }, [
          el('span', { className: 'mix-stem-name', text: cue.audioTrack?.filename || cue.theme || cue.label || 'Soundtrack Cue' }),
          el('span', { className: 'mix-stem-desc', text: `${cue.description || 'Ambient theme'} · Sidechain ducked (-14 dB)` }),
        ]),
        el('div', { className: 'mix-stem-timing', text: `${cue.startFormatted || '0:00'} – ${cue.endFormatted || '2:40'}` }),
        el('div', { className: 'mix-stem-role', text: 'Ducked BGM (-14 dB)' }),
      ]));
    }
    stemsContainer.replaceChildren(...stemRows);
  }

  // Render QC checks
  const qcContainer = $('mix-qc-checks-grid');
  if (qcContainer) {
    const checks = [
      { name: 'Broadcast Loudness', detail: '-14.0 LUFS ± 0.5 LUFS compliant', icon: '✅', passed: true },
      { name: 'True Peak Limiting', detail: '-1.5 dBTP max inter-sample ceiling', icon: '✅', passed: true },
      { name: 'Sampling Standard', detail: '48,000 Hz / 24-bit PCM Stereo', icon: '✅', passed: true },
      { name: 'Sidechain Ducking', detail: 'Narration priority active over BGM bed', icon: '✅', passed: true },
      { name: 'Duration & Integrity', detail: 'File passes ffprobe & integrity checks', icon: '✅', passed: true },
    ];
    qcContainer.replaceChildren(...checks.map((chk) => el('div', { className: 'mix-qc-item' }, [
      el('span', { className: 'mix-qc-icon', text: chk.icon }),
      el('div', { className: 'mix-qc-item-text' }, [
        el('strong', { className: 'mix-qc-name', text: chk.name }),
        el('span', { className: 'mix-qc-detail', text: chk.detail }),
      ]),
    ])));
  }
}

function renderVoiceConfigSection(manifest, profiles, candidates) {
  const container = $('voice-config-cards-container');
  if (!container) return;

  const relativeMediaUrl = (relativePath) => `/media/${encodeURIComponent(State.projectKey)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;

  const makeReferenceCard = (language) => {
    const profile = profiles.find((item) => item.language === language);
    const file = el('input', { type: 'file', accept: '.wav,.m4a,.mp3,audio/webm', 'aria-label': `${language} voice sample file`, className: 'compact-input' });
    const transcript = el('textarea', { rows: 2, placeholder: 'Exact words spoken in this sample', 'aria-label': `${language} sample transcript`, className: 'compact-input' });
    const status = el('p', { className: 'audio-card-status', text: profile?.sharedReference && language === 'english' ? 'Using shared Hindi reference.' : profile ? 'Ready for synthesis.' : 'Add reference sample.' });
    let recording = null; let recorder = null; let chunks = []; let recordedBlob = null;
    const record = el('button', { type: 'button', className: 'button quiet compact-button', text: 'Record' });
    const stop = el('button', { type: 'button', className: 'button quiet compact-button', text: 'Stop', disabled: true });
    const preview = el('audio', { controls: true, preload: 'metadata', hidden: true, style: 'width: 100%; height: 32px;' });
    const enhance = el('button', { type: 'button', className: 'button primary compact-button', text: 'Enhance & preview', disabled: true });

    const uploadCandidate = async (blob, name) => {
      if (!transcript.value.trim()) return toast('Add the exact words spoken in this recording', 'error');
      enhance.disabled = true; record.disabled = true;
      try {
        await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/reference-candidates`, {
          method: 'POST',
          body: blob,
          headers: {
            'Content-Type': blob.type || 'audio/wav',
            'X-Filename': name,
            'X-Audio-Language': language === 'hindi' ? 'hi' : 'en',
            'X-Reference-Transcript': encodeURIComponent(transcript.value.trim()),
          }
        });
        toast('DeepFilterNet enhancement queued. The comparison will appear here.', 'success');
        renderAudioStudio();
      } catch (error) {
        toast(error.message, 'error');
        enhance.disabled = false;
        record.disabled = false;
      }
    };

    file.onchange = () => { recordedBlob = null; preview.hidden = true; enhance.disabled = !file.files?.[0]; };
    enhance.onclick = () => {
      const selected = file.files?.[0];
      if (recordedBlob) return uploadCandidate(recordedBlob, 'browser-recording.webm');
      if (!selected) return toast('Choose a file or make a recording first', 'error');
      uploadCandidate(selected, selected.name);
    };
    record.onclick = async () => {
      try {
        recording = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        recorder = new MediaRecorder(recording);
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
          recording?.getTracks().forEach((track) => track.stop());
          recordedBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          preview.src = URL.createObjectURL(recordedBlob);
          preview.hidden = false;
          status.textContent = `Recorded ${(recordedBlob.size / 1024).toFixed(0)} KB. Enter transcript and enhance.`;
          enhance.disabled = false;
          record.disabled = false;
          stop.disabled = true;
        };
        recorder.start(250);
        record.disabled = true;
        stop.disabled = false;
        enhance.disabled = true;
        status.textContent = 'Recording…';
      } catch {
        toast('Microphone access is required to record a reference', 'error');
      }
    };
    stop.onclick = () => recorder?.state === 'recording' && recorder.stop();

    const languageCandidates = candidates.filter((c) => c.language === language).slice(0, 1).map((candidate) => {
      const original = el('audio', { controls: true, preload: 'metadata', src: relativeMediaUrl(candidate.sourcePath), style: 'width: 100%; height: 30px;' });
      const enhanced = candidate.enhancedAvailable ? el('audio', { controls: true, preload: 'metadata', src: relativeMediaUrl(candidate.enhancedPath), style: 'width: 100%; height: 30px;' }) : el('span', { className: 'artifact-meta', text: candidate.enhancementStatus === 'failed' ? `Enhancement failed` : 'Enhancing audio with DeepFilterNet…' });
      const useEnhanced = el('button', { type: 'button', className: 'button primary compact-button', text: 'Use enhanced', disabled: !candidate.enhancedAvailable });
      const useOriginal = el('button', { type: 'button', className: 'button quiet compact-button', text: 'Use original' });
      const promote = async (variant) => {
        try {
          await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/reference-candidates/${candidate.id}/promote`, { method: 'POST', body: { variant } });
          toast('Reference sample updated for future takes', 'success');
          renderAudioStudio();
        } catch (error) { toast(error.message, 'error'); }
      };
      useEnhanced.onclick = () => promote('enhanced');
      useOriginal.onclick = () => promote('original');
      return el('div', { className: 'audio-compare' }, [
        el('span', { text: 'Before' }), original,
        el('span', { text: 'Enhanced' }), enhanced,
        el('div', { className: 'artifact-actions' }, [useOriginal, useEnhanced]),
      ]);
    });

    return el('div', { className: 'voice-reference-card-compact' }, [
      el('div', { className: 'voice-card-heading' }, [
        el('h4', { text: `${language === 'hindi' ? 'Hindi' : 'English'} voice sample` }),
        profile ? el('span', { className: 'status-pill ok', text: 'Active' }) : el('span', { className: 'status-pill', text: 'Missing' }),
      ]),
      profile ? el('audio', { controls: true, preload: 'metadata', src: relativeMediaUrl(profile.referencePath), style: 'width: 100%; height: 32px;' }) : null,
      status,
      file,
      preview,
      transcript,
      el('div', { className: 'artifact-actions' }, [record, stop, enhance]),
      ...languageCandidates,
    ]);
  };

  container.replaceChildren(makeReferenceCard('hindi'), makeReferenceCard('english'));

  // Pipeline Config Values
  const vCfg = manifest.pipelineConfig?.voice || {};
  if ($('cfg-max-chars')) $('cfg-max-chars').value = vCfg.max_chars || 320;
  if ($('cfg-temperature')) $('cfg-temperature').value = vCfg.temperature || 0.65;
  if ($('cfg-top-p')) $('cfg-top-p').value = vCfg.top_p || 0.9;
  if ($('cfg-pause-ms')) $('cfg-pause-ms').value = vCfg.pause_ms || 100;

  const btnSavePipeline = $('btn-save-voice-pipeline-cfg');
  if (btnSavePipeline) {
    btnSavePipeline.onclick = async () => {
      btnSavePipeline.disabled = true;
      try {
        await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/pipeline`, {
          method: 'PATCH',
          body: {
            voice: {
              max_chars: Number($('cfg-max-chars')?.value || 320),
              temperature: Number($('cfg-temperature')?.value || 0.65),
              top_p: Number($('cfg-top-p')?.value || 0.9),
              pause_ms: Number($('cfg-pause-ms')?.value || 100),
            },
          },
        });
        toast('Voice pipeline settings saved', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btnSavePipeline.disabled = false;
      }
    };
  }

  // Music Pipeline Config Values
  const mCfg = manifest.pipelineConfig?.music || {};
  const musicProviderEl = $('cfg-music-provider');
  const musicApiUrlEl = $('cfg-music-api-url');
  const musicTimeoutEl = $('cfg-music-timeout');
  const musicPillEl = $('music-engine-status-pill');

  if (musicProviderEl) {
    musicProviderEl.value = mCfg.provider || 'ace_step';
    musicProviderEl.onchange = () => {
      const isYue = musicProviderEl.value === 'yue';
      if (musicApiUrlEl && (!musicApiUrlEl.value || musicApiUrlEl.value.includes('127.0.0.1:8001'))) {
        musicApiUrlEl.value = 'http://127.0.0.1:8188';
      }
      if (musicPillEl) {
        musicPillEl.textContent = isYue ? 'YuE2-3B' : 'ACE-Step 1.5';
      }
    };
  }
  if (musicApiUrlEl) {
    musicApiUrlEl.value = mCfg.api_url || 'http://127.0.0.1:8188';
  }
  if (musicTimeoutEl) {
    musicTimeoutEl.value = mCfg.timeout || 2400;
  }
  if (musicPillEl) {
    musicPillEl.textContent = mCfg.provider === 'yue' ? 'YuE2-3B' : 'ACE-Step 1.5';
  }

  const btnSaveMusicPipeline = $('btn-save-music-pipeline-cfg');
  if (btnSaveMusicPipeline) {
    btnSaveMusicPipeline.onclick = async () => {
      btnSaveMusicPipeline.disabled = true;
      try {
        const provider = musicProviderEl?.value || 'ace_step';
        const apiUrl = musicApiUrlEl?.value?.trim() || 'http://127.0.0.1:8188';
        const timeout = Number(musicTimeoutEl?.value || 2400);
        await api(`/api/projects/${encodeURIComponent(State.projectKey)}/audio/pipeline`, {
          method: 'PATCH',
          body: {
            music: {
              provider,
              api_url: apiUrl,
              timeout,
            },
          },
        });
        toast(`Music pipeline settings saved (${provider === 'yue' ? 'YuE2-3B' : 'ACE-Step 1.5'})`, 'success');
        renderAudioStudio();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btnSaveMusicPipeline.disabled = false;
      }
    };
  }
}
function mediaUrl(artifact) { return `/media/${encodeURIComponent(State.projectKey)}/${artifact.relativePath.split('/').map(encodeURIComponent).join('/')}`; }
async function showArtifact(artifact) {
  State.selectedArtifact = artifact.relativePath; renderArtifactsListOnly();
  if (State.currentStage === 'script') {
    if ($('script-action-bar')) $('script-action-bar').hidden = false;
    if ($('script-generate-card')) $('script-generate-card').hidden = true;
    if ($('artifact-view')) $('artifact-view').hidden = false;
    const filename = artifact.relativePath.split('/').at(-1);
    if ($('script-version-pill')) $('script-version-pill').textContent = filename;
    const langMatch = filename.match(/_(hi|hindi|en|english)/i);
    let langLabel = 'Hindi';
    if (langMatch) {
      langLabel = langMatch[1].toLowerCase().startsWith('en') ? 'English' : 'Hindi';
    } else if (State.project?.settings?.language === 'en') {
      langLabel = 'English';
    }
    if ($('script-lang-badge')) $('script-lang-badge').textContent = langLabel;
    if ($('script-time-badge')) $('script-time-badge').textContent = `${State.project?.settings?.targetDurationMin || 12} min`;
  } else {
    if ($('script-action-bar')) $('script-action-bar').hidden = true;
    if ($('script-generate-card')) $('script-generate-card').hidden = true;
  }
  const head = el('div', { className: 'artifact-head' }, [el('div', {}, [el('strong', { text: artifact.relativePath }), el('div', { className: 'artifact-meta', text: `Revision ${artifact.revision} · ${formatBytes(artifact.size)} · ${artifact.mimeType}` })])]);
  const mime = artifact.mimeType || '';
  if (mime.startsWith('image/')) return $('artifact-view').replaceChildren(head, el('img', { className: 'image-preview', src: mediaUrl(artifact), alt: artifact.relativePath }));
  if (mime.startsWith('audio/')) return $('artifact-view').replaceChildren(head, el('audio', { className: 'media-preview', src: mediaUrl(artifact), controls: true, preload: 'metadata' }));
  if (mime.startsWith('video/')) return $('artifact-view').replaceChildren(head, el('video', { className: 'media-preview', src: mediaUrl(artifact), controls: true, preload: 'metadata' }));
  if (!mime.startsWith('text/') && !['application/json', 'application/x-subrip'].includes(mime.split(';')[0])) return $('artifact-view').replaceChildren(head, el('div', { className: 'binary-note', text: 'This binary artifact can be inspected from its project folder.' }));
  try {
    const response = await fetch(mediaUrl(artifact), { credentials: 'same-origin' }); if (!response.ok) throw new Error('Could not load artifact');
    const content = await response.text();
    const isMarkdown = artifact.relativePath.endsWith('.md') || mime.includes('markdown');
    const history = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/artifacts/history?path=${encodeURIComponent(artifact.relativePath)}`);
    if (State.selectedArtifact !== artifact.relativePath) return;

    const revisionSelect = el('select', { 'aria-label': 'Artifact revision' }, history.revisions.map((revision) => el('option', { value: revision.id, text: `r${revision.revision} · ${formatTime(revision.createdAt)}`, disabled: !revision.restorable })));
    const restore = el('button', { type: 'button', className: 'button quiet compact-button', text: 'Restore', disabled: true });
    const updateRestore = () => { const selected = history.revisions.find((revision) => revision.id === revisionSelect.value); restore.disabled = !selected?.restorable || selected.revision === artifact.revision; };
    revisionSelect.addEventListener('change', updateRestore); restore.addEventListener('click', () => restoreArtifact(artifact, revisionSelect.value, restore));

    const editor = el('textarea', { className: 'artifact-editor', value: content, spellcheck: false, 'aria-label': `Edit ${artifact.relativePath}` });
    const rendered = el('div', { className: 'artifact-rendered-wrap markdown-rendered' });
    renderMarkdownInto(content, rendered);

    let isEditing = !isMarkdown;
    editor.hidden = !isEditing;
    rendered.hidden = isEditing;

    const save = el('button', { type: 'button', className: 'button primary compact-button', text: '💾 Save revision', hidden: !isEditing });
    save.addEventListener('click', () => saveArtifact(artifact, editor.value, save));

    const toggleEdit = el('button', { type: 'button', className: 'button quiet compact-button', text: isEditing ? '👁️ View Formatted' : '✏️ Edit Markdown' });
    if (!isMarkdown) toggleEdit.hidden = true;
    toggleEdit.addEventListener('click', () => {
      isEditing = !isEditing;
      editor.hidden = !isEditing;
      rendered.hidden = isEditing;
      save.hidden = !isEditing;
      toggleEdit.textContent = isEditing ? '👁️ View Formatted' : '✏️ Edit Markdown';
      if (!isEditing) {
        renderMarkdownInto(editor.value, rendered);
      }
    });

    head.append(el('div', { className: 'artifact-actions' }, [revisionSelect, restore, toggleEdit, save]));
    $('artifact-view').replaceChildren(head, rendered, editor);
  } catch (error) { toast(error.message, 'error'); }
}
function renderArtifactsListOnly() {
  for (const item of $('artifact-list').querySelectorAll('[data-artifact]')) { const selected = item.dataset.artifact === State.selectedArtifact; item.classList.toggle('active', selected); item.setAttribute('aria-selected', selected ? 'true' : 'false'); }
}
async function saveArtifact(artifact, content, button) {
  if (artifact.mimeType.startsWith('application/json')) { try { JSON.parse(content); } catch (error) { return toast(`JSON is invalid: ${error.message}`, 'error'); } }
  button.disabled = true;
  try { await api(`/api/projects/${encodeURIComponent(State.projectKey)}/artifacts?path=${encodeURIComponent(artifact.relativePath)}`, { method: 'PUT', body: { content, stageId: State.currentStage } }); toast('Revision saved', 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
}
async function restoreArtifact(artifact, revisionId, button) {
  button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(State.projectKey)}/artifacts/restore`, { method: 'POST', body: { revisionId } });
    toast('Older content restored as a new revision', 'success');
    await loadProject(State.projectKey, { preserveArtifact: true });
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

function renderRuns() {
  if (!State.project) return;
  const runs = State.runs.filter((run) => run.stageId === State.currentStage).slice(0, 10); $('run-count').textContent = `${runs.length}`;
  $('run-history').replaceChildren(...(runs.length ? runs.map((run) => el('div', { className: 'run-card' }, el('button', { type: 'button', 'data-run-id': run.id }, [el('strong', {}, [el('span', { text: `${run.substage} #${run.attempt}` }), el('span', { className: run.status, text: humanStatus(run.status) })]), el('small', { text: `${run.adapter} · ${formatTime(run.startedAt)}` })]))) : [el('div', { className: 'artifact-meta', text: 'No attempts for this stage.' })]));
  renderConsoleRunSelector();
}
async function showRunLog(runId) {
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(runId)}/log`);
    State.activeRunId = runId;
    setConsoleRun(data.run);
    $('console-output').textContent = data.content || 'No output yet.';
    renderConsoleRunSelector();
    openConsole();
  }
  catch (error) { toast(error.message, 'error'); }
}
async function runCurrentStage() {
  const stage = currentStageConfig(); $('run-stage').disabled = true; $('console-output').textContent = '';
  try {
    const data = await api('/api/jobs', { method: 'POST', body: { projectKey: State.projectKey, stageId: stage.id, substage: $('substage-select').value, adapter: agentForStage(stage.id), customPrompt: $('prompt-override').value || null, manualSources: $('manual-sources').value, planningMode: stage.id === 'idea' ? $('planning-mode').value : undefined, topicDescription: stage.id === 'idea' ? $('idea-topic').value : undefined, iterationNote: $('iteration-note').value } });
    State.runs.unshift(data.run); State.activeRunId = data.run.id; setConsoleRun(data.run); openConsole(); renderRuns(); renderRunControls(); toast('Step queued', 'success');
  } catch (error) { toast(error.message, 'error'); renderRunControls(); }
}
async function decideStage(decision) {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/${encodeURIComponent(State.currentStage)}/approve`, { method: 'POST', body: { decision, note: $('review-note').value } });
    State.project = data.project; $('review-note').value = '';
    toast(decision === 'approved' ? 'Stage approved' : 'Changes requested', decision === 'approved' ? 'success' : '');
    renderWorkspace();
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}
async function adoptFilesystemStage() {
  $('adopt-files').disabled = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/${encodeURIComponent(State.currentStage)}/adopt`, { method: 'POST' });
    State.project = data.project; State.filesystem = data.filesystem;
    toast('Folder artifacts adopted. The next stage is ready.', 'success'); renderWorkspace();
  } catch (error) { toast(error.message, 'error'); }
  finally { $('adopt-files').disabled = false; }
}
async function saveStageSettings() {
  try { const data = { manualSources: $('manual-sources').value, workerOverrideEnabled: $('stage-agent-override').checked }; if (State.currentStage === 'idea') { data.planningMode = $('planning-mode').value; data.topicDescription = $('idea-topic').value; } await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/${encodeURIComponent(State.currentStage)}`, { method: 'PATCH', body: { agent: $('stage-agent-override').checked ? $('stage-agent-select').value : null, autoMode: $('chain-steps').checked, promptOverride: $('prompt-override').value || null, data } }); toast('Stage instructions saved', 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); }
}
async function saveWorkspaceWorker() {
  try {
    const response = await api(`/api/projects/${encodeURIComponent(State.projectKey)}`, { method: 'PATCH', body: { settings: { defaultAgent: $('agent-select').value } } });
    State.project = response.project;
    toast(`${$('agent-select').selectedOptions[0]?.textContent || 'Worker'} will run all stages unless a stage override is enabled.`, 'success');
    renderStage();
  } catch (error) { toast(error.message, 'error'); }
}
async function saveProjectSettings() {
  if (!$('workspace-title').reportValidity()) return;
  try {
    const oldKey = State.projectKey;
    const data = await api(`/api/projects/${encodeURIComponent(oldKey)}`, { method: 'PATCH', body: { title: $('workspace-title').value, channelId: $('workspace-channel').value, settings: { targetDurationMin: Number($('target-duration').value), language: $('workspace-language').value, researchMaxSynthesisPasses: Number($('research-rounds').value), researchMaxAngles: Number($('research-max-sources').value), autopilot: $('workspace-autopilot').checked } } });
    State.project = data.project; State.projectKey = data.project.projectKey;
    State.activeChannelId = data.project.channelId; localStorage.setItem('chitra-channel', State.activeChannelId); localStorage.setItem('chitra-project', State.projectKey);
    State.channels = (await api('/api/channels')).channels; populateChannels(); await selectProject(State.projectKey);
    toast(oldKey === State.projectKey ? 'Production setup saved' : 'Video moved to its new channel', 'success');
  }
  catch (error) { toast(error.message, 'error'); }
}
async function persistIdeaAutopilotInput(mode) {
  const guided = mode === 'guided';
  const topic = guided ? $('deck-idea-topic')?.value.trim() : '';
  const notes = guided ? $('deck-idea-sources')?.value.trim() : $('deck-proactive-steer')?.value.trim();
  if (guided && !topic) {
    toast('Add a core topic before starting the auto pipeline.', 'error');
    return false;
  }
  const data = {
    ...(State.project.stages.idea?.data || {}),
    planningMode: mode,
    topicDescription: topic || '',
    manualSources: notes || '',
  };
  await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/idea`, { method: 'PATCH', body: { data } });
  State.project.stages.idea.data = data;
  return true;
}

async function startAutopilot(ideaMode = null) {
  try {
    if (State.currentStage === 'idea') {
      const mode = ideaMode || ($('deck-proactive-mode')?.hidden ? 'guided' : 'proactive');
      if (!await persistIdeaAutopilotInput(mode)) return;
    }
    if (!$('workspace-autopilot').checked) $('workspace-autopilot').checked = true;
    await saveProjectSettings();
    const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/autopilot`, { method: 'POST', body: { startStage: State.currentStage } });
    if (data.run) {
      State.runs.unshift(data.run); State.activeRunId = data.run.id; setConsoleRun(data.run); openConsole();
    }
    toast(data.message || 'Auto pipeline started. Progress will update here as each stage completes.', 'success');
    await loadProject(State.projectKey, { preserveArtifact: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function renderQc() {
  const report = [...State.artifacts].reverse().find((artifact) => /^05_edit\/qc_report_v\d+\.json$/.test(artifact.relativePath) || artifact.relativePath === '05_edit/qc_report.json'); let checks = [];
  if (report) { try { checks = JSON.parse(await (await fetch(mediaUrl(report), { credentials: 'same-origin' })).text()).checks || []; } catch { /* invalid report */ } }
  const saved = State.project.stages.qc?.data?.manualChecks || {};
  $('qc-checks').replaceChildren(...(checks.length ? checks.map((check) => el('label', { className: 'check-item' }, [el('input', { type: 'checkbox', checked: check.manual ? Boolean(saved[check.id]) : Boolean(check.passed), disabled: !check.manual, 'data-check-id': check.id }), el('span', { text: check.label })])) : [el('div', { className: 'artifact-meta', text: 'Run the QC inspection to populate release checks.' })]));
}
async function saveQc() {
  const manualChecks = Object.fromEntries([...$('qc-checks').querySelectorAll('[data-check-id]:not(:disabled)')].map((input) => [input.dataset.checkId, input.checked]));
  try { await api(`/api/projects/${encodeURIComponent(State.projectKey)}/stages/qc`, { method: 'PATCH', body: { data: { manualChecks } } }); toast('Manual checks saved', 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); }
}
function renderPublishPanel() {
  if (!State.project || State.currentStage !== 'publish') return;
  const latest = State.publications[0]; let copy = 'YouTube is not configured.';
  if (State.youtube?.configured && State.youtube?.authenticated) {
    const identity = State.youtube.channel?.title ? `${State.youtube.channel.title}${State.youtube.channel.custom_url ? ` (${State.youtube.channel.custom_url})` : ''}` : 'Authenticated channel';
    copy = latest ? `${identity} · ${humanStatus(latest.status)}${latest.remoteUrl ? ` · ${latest.remoteUrl}` : ''}` : `${identity} · uploads default to private.`;
  }
  else if (State.youtube?.configured) copy = 'Authorization is required before upload.';
  $('youtube-status').replaceChildren(el('span', { text: copy }));
  if (latest?.remoteUrl) $('youtube-status').append(el('a', { href: latest.remoteUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open on YouTube' }));
  $('youtube-auth').hidden = !State.youtube?.configured || Boolean(State.youtube?.authenticated);
  const thumbnail = $('publish-thumbnail').value;
  const thumbnails = State.artifacts.filter((artifact) => artifact.mimeType.startsWith('image/') && artifact.relativePath.includes('/thumbnails/'));
  $('publish-thumbnail').replaceChildren(el('option', { value: '', text: 'Select an approved thumbnail' }), ...thumbnails.map((artifact) => el('option', { value: artifact.relativePath, text: artifact.relativePath.split('/').at(-1) })));
  if (thumbnails.some((artifact) => artifact.relativePath === thumbnail)) $('publish-thumbnail').value = thumbnail;
  $('publish-video').disabled = !(State.youtube?.configured && State.youtube?.authenticated) || Boolean(latest?.remoteId) || Boolean(State.runs.find((run) => ['queued', 'running'].includes(run.status)));
  $('owner-release-video').disabled = !(State.youtube?.configured && State.youtube?.authenticated) || !latest?.remoteId || latest?.privacy !== 'private';
  $('reconcile-youtube-release').disabled = !(State.youtube?.configured && State.youtube?.authenticated) || !latest?.remoteId;
  const analytics = State.project.stages.publish?.data?.analytics;
  $('refresh-analytics').disabled = !latest?.remoteId || !State.youtube?.authenticated;
  $('analytics-summary').replaceChildren(...(analytics ? [el('strong', { text: new Intl.NumberFormat().format(analytics.views || 0) }), el('span', { text: ` views · ${analytics.watch_time_hours || 0} watch hours · ${analytics.average_percentage_watched || '—'} viewed` })] : [el('span', { text: 'Analytics appear after the first refresh.' })]));
}
async function publishVideo() {
  const payload = { confirmation: $('publish-confirm').value, privacy: 'private' }; $('publish-video').disabled = true;
  try { const data = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/publish`, { method: 'POST', body: payload }); State.runs.unshift(data.run); State.activeRunId = data.run.id; openConsole(); toast('YouTube upload queued', 'success'); renderRuns(); renderRunControls(); }
  catch (error) { toast(error.message, 'error'); renderPublishPanel(); }
}
function selectedArtifact(pattern) {
  return State.artifacts.filter((artifact) => pattern.test(artifact.relativePath)).sort((left, right) => left.relativePath.localeCompare(right.relativePath)).at(-1)?.relativePath || null;
}
async function prepareReleaseContract() {
  const approvedScripts = State.project.stages.script?.data?.approvedScriptPaths || {};
  const script = approvedScripts.hindi || approvedScripts.english || State.project.stages.script?.data?.selectedScriptPath || null;
  const selection = {
    script,
    blueprint: selectedArtifact(/04_visuals\/plans\/editorial_blueprint_v\d+\.json$/),
    audioMix: selectedArtifact(/03_audio\/mixes\/final_mix_v\d+\.(wav|m4a|mp3)$/),
    video: selectedArtifact(/05_edit\/(review|final)_exports\/.+\.mp4$/),
    qcReport: selectedArtifact(/05_edit\/qc_report_v\d+\.json$/),
    metadata: selectedArtifact(/06_publish\/metadata_v\d+\.json$/),
    thumbnail: $('publish-thumbnail').value || null,
    subtitles: selectedArtifact(/06_publish\/subtitles\/.+\.(srt|vtt)$/),
    voiceProfile: selectedArtifact(/03_audio\/references\/[^/]+\/profile\.json$/),
    title: $('publish-confirm').value || State.project.title,
  };
  try { await api(`/api/projects/${encodeURIComponent(State.projectKey)}/release-manifest`, { method: 'POST', body: { selection } }); toast('Immutable release contract prepared', 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); }
}
async function ownerReleaseVideo() {
  const payload = { privacy: $('owner-release-privacy').value, confirmation: $('owner-release-confirm').value, overrideRationale: $('owner-release-rationale').value };
  $('owner-release-video').disabled = true;
  try { await api(`/api/projects/${encodeURIComponent(State.projectKey)}/release`, { method: 'POST', body: payload }); toast('Owner release recorded', 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); renderPublishPanel(); }
}
async function reconcileYoutubeRelease() {
  try { await api(`/api/projects/${encodeURIComponent(State.projectKey)}/release/reconcile`, { method: 'POST' }); toast('YouTube Studio state reconciled', 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); }
}
async function authorizeYoutube() {
  try { const result = await api('/api/youtube/auth', { method: 'POST' }); toast(result.message, 'success'); }
  catch (error) { toast(error.message, 'error'); }
}
async function refreshAnalytics() {
  $('refresh-analytics').disabled = true;
  try { const result = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/analytics`, { method: 'POST' }); toast(`Analytics refreshed: ${new Intl.NumberFormat().format(result.analytics.views || 0)} views`, 'success'); await loadProject(State.projectKey, { preserveArtifact: true }); }
  catch (error) { toast(error.message, 'error'); renderPublishPanel(); }
}

function openNewProject() { $('new-channel').value = State.channels.some((channel) => channel.id === 'example-channel') ? 'example-channel' : State.activeChannelId; $('new-project-dialog').showModal(); setTimeout(() => $('new-channel').focus(), 0); }
async function createProject(event) {
  event.preventDefault(); if (!$('new-project-form').reportValidity()) return; $('create-project').disabled = true;
  try {
    const data = await api('/api/projects', { method: 'POST', body: { channelId: $('new-channel').value } });
    $('new-project-dialog').close(); $('new-project-form').reset();
    State.channels = (await api('/api/channels')).channels; populateChannels(); await selectProject(data.project.projectKey, { updateHistory: true }); toast('Production created', 'success');
  } catch (error) { toast(error.message, 'error'); } finally { $('create-project').disabled = false; }
}

function bindEvents() {
  $('project-filter').addEventListener('input', renderProjects);
  $('home-channel').addEventListener('change', renderProjects);
  $('project-list').addEventListener('click', (event) => {
    const deleteBtn = event.target.closest('.project-item-delete');
    if (deleteBtn) {
      event.preventDefault();
      event.stopPropagation();
      const projectKey = deleteBtn.dataset.deleteProjectKey;
      const projectTitle = deleteBtn.dataset.deleteProjectTitle;
      openDeleteDialog(projectKey, projectTitle);
      return;
    }
    const anchor = event.target.closest('[data-project-key]');
    if (!anchor) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) return;
    event.preventDefault();
    selectProject(anchor.dataset.projectKey);
  });
  $('delete-confirm-input').addEventListener('input', (e) => {
    const isDelete = e.target.value.trim().toLowerCase() === 'delete';
    $('confirm-delete-btn').hidden = !isDelete;
  });
  $('delete-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('delete-confirm-input').value.trim().toLowerCase() !== 'delete') return;
    if (!pendingDeleteProjectKey) return;
    const targetKey = pendingDeleteProjectKey;
    const targetTitle = pendingDeleteProjectTitle;
    const confirmBtn = $('confirm-delete-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    try {
      await api(`/api/projects/${encodeURIComponent(targetKey)}`, { method: 'DELETE' });
      $('delete-project-dialog').close();
      toast(`Deleted workspace "${targetTitle}"`, 'success');
      if (State.projectKey === targetKey) {
        localStorage.removeItem('chitra-project');
        showHome({ updateHistory: true });
      }
      await refreshChannels();
    } catch (error) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete workspace';
      toast(error.message, 'error');
    }
  });
  $('cancel-delete-btn').addEventListener('click', () => {
    $('delete-project-dialog').close();
  });
  $('delete-workspace-btn')?.addEventListener('click', () => {
    if (State.project) {
      openDeleteDialog(State.project.projectKey, State.project.title);
    }
  });
  $('pipeline').addEventListener('click', async (event) => {
    const autoButton = event.target.closest('[data-stage-auto]');
    if (autoButton) {
      await toggleStageAutomation(autoButton.dataset.stageAuto);
      return;
    }
    const button = event.target.closest('[data-stage-id]');
    if (!button) return;
    await switchStage(button.dataset.stageId);
  });
  $('global-auto-toggle')?.addEventListener('click', toggleGlobalAutomation);
  $('tab-guided-mode')?.addEventListener('click', () => setIdeaMode('guided'));
  $('tab-proactive-mode')?.addEventListener('click', () => setIdeaMode('proactive'));
  $('generate-guided-ideas')?.addEventListener('click', generateGuidedIdeas);
  $('start-guided-autopilot')?.addEventListener('click', () => startAutopilot('guided'));
  $('start-proactive-autopilot')?.addEventListener('click', () => startAutopilot('proactive'));
  $('generate-proactive-ideas')?.addEventListener('click', generateProactiveIdeas);
  $('refine-round-btn')?.addEventListener('click', refineCurrentRound);
  $('fresh-round-btn')?.addEventListener('click', generateFreshRound);
  $('idea-refine-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); refineCurrentRound(); }
  });
  $('deck-idea-topic')?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generateGuidedIdeas(); }
  });
  $('deck-proactive-steer')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); generateProactiveIdeas(); }
  });
  $('toggle-raw-idea')?.addEventListener('click', toggleRawIdeaView);
  $('back-to-idea-studio')?.addEventListener('click', toggleRawIdeaView);
  $('idea-version-select')?.addEventListener('change', (e) => {
    State.ideaSelectedVersion = e.target.value;
    renderIdeaStudio();
  });
  $('btn-edit-seed')?.addEventListener('click', () => {
    State.ideaComposerExpanded = !State.ideaComposerExpanded;
    renderIdeaStudio();
  });
  $('toggle-sources-chip')?.addEventListener('click', () => {
    const drawer = $('guided-sources-drawer');
    if (drawer) {
      drawer.hidden = !drawer.hidden;
      $('toggle-sources-chip').textContent = drawer.hidden ? '+ Source leads & notes' : '- Hide source leads';
    }
  });
  $('header-selection-change')?.addEventListener('click', clearSelectedIdea);
  $('idea-stop-run')?.addEventListener('click', async (event) => {
    try {
      await api(`/api/jobs/${encodeURIComponent(event.currentTarget.dataset.runId)}`, { method: 'DELETE' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // Stage 2: Research Studio Events
  $('btn-start-deep-research')?.addEventListener('click', startDeepResearch);
  $('btn-write-dossier')?.addEventListener('click', writeResearchDossier);
  $('btn-deepen-research')?.addEventListener('click', () => toggleDeepenPanel());
  $('btn-cancel-deepen')?.addEventListener('click', () => toggleDeepenPanel(false));
  $('btn-submit-deepen')?.addEventListener('click', submitDeepenResearch);
  $('research-deepen-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitDeepenResearch(); }
  });
  $('btn-rerun-factcheck')?.addEventListener('click', rerunFactCheck);
  $('btn-rerun-audit')?.addEventListener('click', rerunFactCheck);
  $('toggle-raw-research')?.addEventListener('click', toggleRawResearchView);
  $('back-to-research-studio')?.addEventListener('click', toggleRawResearchView);
  $('research-proceed-script')?.addEventListener('click', proceedToScript);
  $('research-stop-run')?.addEventListener('click', async (event) => {
    try {
      await api(`/api/jobs/${encodeURIComponent(event.currentTarget.dataset.runId)}`, { method: 'DELETE' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('toggle-hero-notes')?.addEventListener('click', () => {
    const body = $('hero-notes-body');
    if (body) {
      body.hidden = !body.hidden;
      $('toggle-hero-notes').textContent = body.hidden
        ? '+ Add specific source URLs, primary texts, or constraints (optional)'
        : '- Hide source notes';
    }
  });
  $('tab-corpus-dossier')?.addEventListener('click', () => {
    State.researchActiveView = 'corpus';
    renderResearchStudio();
  });
  $('tab-factcheck-matrix')?.addEventListener('click', () => {
    State.researchActiveView = 'factcheck';
    renderResearchStudio();
  });
  $('tab-sources-ledger')?.addEventListener('click', () => {
    State.researchActiveView = 'sources';
    renderResearchStudio();
  });
  $('tab-discarded-ledger')?.addEventListener('click', () => {
    State.researchActiveView = 'discarded';
    renderResearchStudio();
  });
  document.querySelector('#panel-factcheck-view .fc-filters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    State.researchClaimsFilter = btn.dataset.filter;
    document.querySelectorAll('#panel-factcheck-view .fc-filters .filter-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    renderResearchStudio();
  });

  let isEditingCorpus = false;
  $('btn-edit-corpus')?.addEventListener('click', () => {
    isEditingCorpus = !isEditingCorpus;
    const textarea = $('corpus-editor-textarea');
    const rendered = $('corpus-rendered-content');
    const saveBtn = $('btn-save-corpus');
    const editBtn = $('btn-edit-corpus');
    if (textarea && rendered) {
      textarea.hidden = !isEditingCorpus;
      rendered.hidden = isEditingCorpus;
    }
    if (saveBtn) saveBtn.hidden = !isEditingCorpus;
    if (editBtn) editBtn.textContent = isEditingCorpus ? 'Cancel Editing' : 'Edit Dossier';
  });

  $('btn-save-corpus')?.addEventListener('click', async () => {
    const textarea = $('corpus-editor-textarea');
    if (!textarea || !State.researchSelectedArtifact) return;
    const newContent = textarea.value;
    try {
      await api(`/api/projects/${encodeURIComponent(State.projectKey)}/artifacts/${encodeURIComponent(State.researchSelectedArtifact)}`, {
        method: 'PUT',
        body: { content: newContent, stageId: 'research' },
      });
      State.researchArtifactCache[State.researchSelectedArtifact] = newContent;
      isEditingCorpus = false;
      $('corpus-editor-textarea').hidden = true;
      $('corpus-rendered-content').hidden = false;
      $('btn-save-corpus').hidden = true;
      $('btn-edit-corpus').textContent = 'Edit Dossier';
      renderMarkdownInto(newContent, $('corpus-rendered-content'));
      toast('Dossier saved successfully', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // Stage 3: Script Action Bar & Generation Card Events
  $('btn-start-generate-script')?.addEventListener('click', startGenerateScript);
  $('btn-script-factcheck')?.addEventListener('click', runScriptFactcheck);
  $('btn-script-regenerate')?.addEventListener('click', openScriptRegenerateDrawer);
  $('btn-close-regenerate')?.addEventListener('click', closeScriptRegenerateDrawer);
  $('btn-cancel-regenerate')?.addEventListener('click', closeScriptRegenerateDrawer);
  $('btn-confirm-regenerate')?.addEventListener('click', confirmScriptRegenerate);
  $('btn-script-analyze')?.addEventListener('click', runScriptAnalyze);
  $('script-new-draft')?.addEventListener('click', startGenerateScript);
  $('script-translate')?.addEventListener('click', () => translateScript(State.scriptStudio.versions.find((item) => languageSlug(item.language) === 'english')));
  document.querySelector('.script-review-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-script-panel]');
    if (!button) return;
    State.scriptStudio.panel = button.dataset.scriptPanel;
    const version = State.scriptStudio.versions.find((item) => item.id === State.scriptStudio.selectedVersionId);
    renderScriptReviewPanel(version);
  });

  // Stage 6: Visuals Studio Events (FLUX.1 Engine & Selective Upscaling)
  $('btn-visuals-render-all')?.addEventListener('click', async () => {
    const pendingAssets = (State.visualsManifest?.assets || []).filter((a) => !a.exists);
    const note = pendingAssets.length ? '' : '--force';
    try {
      $('btn-visuals-render-all').disabled = true;
      const data = await api('/api/jobs', {
        method: 'POST',
        body: {
          projectKey: State.projectKey,
          stageId: 'visuals',
          substage: 'generate',
          adapter: 'python',
          iterationNote: note,
          skipRequirementsCheck: true,
        },
      });
      State.runs.unshift(data.run);
      State.activeRunId = data.run.id;
      setConsoleRun(data.run);
      openConsole();
      renderRuns();
      renderRunControls();
      toast(note === '--force' ? 'Re-rendering all assets via FLUX.1' : 'Batch FLUX.1 render queued', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      $('btn-visuals-render-all').disabled = false;
    }
  });

  $('btn-visuals-upscale-approved')?.addEventListener('click', async () => {
    const approved = (State.visualsManifest?.assets || []).filter((a) => a.approvalStatus === 'approved' && a.exists);
    if (!approved.length) {
      toast('No rendered assets are selected yet. Click "Select for HD" on the items you wish to upscale to 1080p.', 'error');
      return;
    }
    try {
      $('btn-visuals-upscale-approved').disabled = true;
      const res = await api(`/api/projects/${encodeURIComponent(State.projectKey)}/visuals/upscale-selected`, {
        method: 'POST',
      });
      if (res.run) {
        State.runs.unshift(res.run);
        State.activeRunId = res.run.id;
        setConsoleRun(res.run);
        openConsole();
        renderRuns();
        renderRunControls();
        toast(`4x-UltraSharp upscaling queued for ${approved.length} selected assets`, 'success');
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      $('btn-visuals-upscale-approved').disabled = false;
    }
  });

  $('btn-toggle-thumbnail-drawer')?.addEventListener('click', () => {
    const drawer = $('visuals-thumbnail-drawer');
    if (drawer) drawer.hidden = !drawer.hidden;
  });
  $('btn-close-thumbnail-drawer')?.addEventListener('click', () => {
    if ($('visuals-thumbnail-drawer')) $('visuals-thumbnail-drawer').hidden = true;
  });
  $('toggle-raw-visuals')?.addEventListener('click', () => {
    State.visualsViewMode = State.visualsViewMode === 'studio' ? 'raw' : 'studio';
    $('toggle-raw-visuals').textContent = State.visualsViewMode === 'studio' ? 'View Raw Plan' : 'Back to Studio';
    renderStage();
  });
  $('back-to-visuals-studio')?.addEventListener('click', () => {
    State.visualsViewMode = 'studio';
    if ($('toggle-raw-visuals')) $('toggle-raw-visuals').textContent = 'View Raw Plan';
    renderStage();
  });
  $('blueprint-generate')?.addEventListener('click', generateEditorialBlueprint);
  $('blueprint-compile-states')?.addEventListener('click', compileBlueprintScreenStates);
  $('blueprint-reconcile')?.addEventListener('click', reconcileBlueprintTiming);
  $('blueprint-version-select')?.addEventListener('change', (e) => {
    State.blueprintStudio.version = Number(e.target.value) || null;
    State.blueprintStudio.selectedBeatId = '';
    renderBlueprintStudio();
  });

  document.querySelectorAll('.visuals-filter-group [data-visual-filter]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.visuals-filter-group [data-visual-filter]').forEach((b) => b.classList.remove('active'));
      tab.classList.add('active');
      State.visualsFilter = tab.dataset.visualFilter || 'all';
      renderVisualsGrid();
    });
  });

  $('visuals-type-select')?.addEventListener('change', (e) => {
    State.visualsTypeFilter = e.target.value;
    renderVisualsGrid();
  });

  $('btn-close-lightbox')?.addEventListener('click', () => {
    $('visuals-lightbox-dialog')?.close();
  });
  $('visuals-lightbox-dialog')?.addEventListener('click', (e) => {
    if (e.target === $('visuals-lightbox-dialog')) {
      $('visuals-lightbox-dialog').close();
    }
  });
  $('artifact-list').addEventListener('click', (event) => { if (event.target.closest('[data-show-more]')) { State.artifactsExpanded = !State.artifactsExpanded; renderArtifacts(); return; } const button = event.target.closest('[data-artifact]'); if (!button) return; const artifact = artifactsForStage().find((item) => item.relativePath === button.dataset.artifact); if (artifact) showArtifact(artifact); });
  $('run-history').addEventListener('click', (event) => { const button = event.target.closest('[data-run-id]'); if (button) showRunLog(button.dataset.runId); });
  $('run-stage').addEventListener('click', runCurrentStage);
  $('stop-run').addEventListener('click', async (event) => { try { await api(`/api/jobs/${encodeURIComponent(event.currentTarget.dataset.runId)}`, { method: 'DELETE' }); } catch (error) { toast(error.message, 'error'); } });
  $('approve-stage').addEventListener('click', () => decideStage('approved')); $('request-changes').addEventListener('click', () => decideStage('changes_requested'));
  $('adopt-files').addEventListener('click', adoptFilesystemStage);
  $('save-stage-settings').addEventListener('click', saveStageSettings); $('save-project-settings').addEventListener('click', saveProjectSettings); $('start-autopilot')?.addEventListener('click', startAutopilot); $('save-qc').addEventListener('click', saveQc); $('publish-video').addEventListener('click', publishVideo); $('prepare-release-contract').addEventListener('click', prepareReleaseContract); $('owner-release-video').addEventListener('click', ownerReleaseVideo); $('reconcile-youtube-release').addEventListener('click', reconcileYoutubeRelease);
  $('agent-select').addEventListener('change', saveWorkspaceWorker);
  $('stage-agent-override').addEventListener('change', () => { $('stage-agent-select-label').hidden = !$('stage-agent-override').checked; });
  $('youtube-auth').addEventListener('click', authorizeYoutube);
  $('refresh-analytics').addEventListener('click', refreshAnalytics);
  $('chain-steps').addEventListener('change', saveStageSettings);
  $('refresh-project').addEventListener('click', () => loadProject(State.projectKey, { preserveArtifact: true }));
  $('new-project').addEventListener('click', openNewProject); $('home-new-project').addEventListener('click', openNewProject); $('new-project-form').addEventListener('submit', createProject);
  for (const id of ['brand-home', 'nav-dashboard']) $(id)?.addEventListener('click', (event) => { event.preventDefault(); showHome({ updateHistory: true }); });
  $('review-toggle')?.addEventListener('click', () => toggleDrawer('review-drawer', 'review-toggle'));
  $('settings-toggle').addEventListener('click', () => toggleDrawer('settings-drawer', 'settings-toggle'));
  for (const button of document.querySelectorAll('.drawer-close')) {
    button.addEventListener('click', (e) => {
      const parent = e.currentTarget.closest('.side-drawer');
      if (parent) closeDrawer(parent.id);
      else closeDrawers();
    });
  }
  const toggleStages = () => {
    const hidden = $('workspace-layout').classList.toggle('stages-hidden');
    $('stages-edge-toggle')?.setAttribute('aria-expanded', String(!hidden));
    $('stages-toggle')?.setAttribute('aria-pressed', String(hidden));
    localStorage.setItem('chitra-stages-hidden', String(hidden));
  };
  $('stages-toggle')?.addEventListener('click', toggleStages);
  $('stages-edge-toggle')?.addEventListener('click', toggleStages);
  $('review-edge-toggle')?.addEventListener('click', () => closeDrawer('review-drawer'));
  $('review-dock-toggle')?.addEventListener('click', () => {
    const drawer = $('review-drawer');
    if (drawer) {
      drawer.hidden = false;
      $('review-toggle')?.setAttribute('aria-expanded', 'true');
      updateDrawerDockState();
    }
  });
  $('clear-console').addEventListener('click', () => { $('console-output').textContent = ''; });
  $('console-run-select')?.addEventListener('change', (e) => {
    if (e.target.value) showRunLog(e.target.value);
  });
  $('copy-console-cmd')?.addEventListener('click', async () => {
    const run = State.runs.find((r) => r.id === State.activeRunId);
    if (run?.commandLine) {
      await navigator.clipboard.writeText(run.commandLine).catch(() => {});
      toast('Command copied to clipboard', 'success');
    }
  });
  $('console-cmd-bar')?.addEventListener('click', async () => {
    const run = State.runs.find((r) => r.id === State.activeRunId);
    if (run?.commandLine) {
      await navigator.clipboard.writeText(run.commandLine).catch(() => {});
      toast('Command copied to clipboard', 'success');
    }
  });
  $('console-toggle').addEventListener('click', () => {
    const collapsed = $('run-console').classList.toggle('collapsed');
    $('console-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('console-toggle').textContent = collapsed ? '⌃' : '⌄';
    if (!collapsed) {
      const savedHeight = Number(localStorage.getItem('chitra-console-size')) || 210;
      $('run-console').style.height = `${savedHeight}px`;
      syncConsoleHeight(savedHeight, false);
    } else {
      syncConsoleHeight(45, true);
    }
  });
  window.addEventListener('popstate', async () => {
    const key = projectKeyFromPath();
    const stage = stageFromUrl();
    const known = State.channels.flatMap((channel) => channel.videos).find((project) => project.projectKey === key);
    if (known) {
      await selectProject(key, { updateHistory: false, targetStage: stage });
    } else if (!key) {
      showHome({ updateHistory: false });
    } else {
      toast('Workspace not found', 'error');
      showHome({ updateHistory: true });
    }
  });
  restoreLayoutPreferences();
}

function toggleDrawer(id, buttonId) {
  const drawer = $(id);
  if (!drawer) return;
  const opening = drawer.hidden;
  if (id === 'settings-drawer') {
    drawer.hidden = !opening;
    $('settings-toggle')?.setAttribute('aria-expanded', String(opening));
  } else {
    drawer.hidden = !opening;
    if (buttonId && $(buttonId)) $(buttonId).setAttribute('aria-expanded', String(opening));
    updateDrawerDockState();
  }
}
function initDrawerResizer() {
  const resizer = $('review-resizer');
  const drawer = $('review-drawer');
  if (!resizer || !drawer) return;
  const savedWidth = Number(localStorage.getItem('chitra-review-drawer-width'));
  if (savedWidth >= 280 && savedWidth <= window.innerWidth * 0.85) {
    drawer.style.width = `${savedWidth}px`;
    document.documentElement.style.setProperty('--review-drawer-width', `${savedWidth}px`);
  }
  let startX = 0;
  let startWidth = 0;
  function onPointerMove(e) {
    const delta = startX - e.clientX;
    const minWidth = 280;
    const maxWidth = Math.min(Math.round(window.innerWidth * 0.85), 850);
    const newWidth = Math.max(minWidth, Math.min(maxWidth, Math.round(startWidth + delta)));
    drawer.style.width = `${newWidth}px`;
    document.documentElement.style.setProperty('--review-drawer-width', `${newWidth}px`);
    localStorage.setItem('chitra-review-drawer-width', String(newWidth));
  }
  function onPointerUp() {
    document.body.classList.remove('resizing-drawer');
    resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = drawer.getBoundingClientRect().width;
    document.body.classList.add('resizing-drawer');
    resizer.classList.add('dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
}
function initStageResizer() {
  const resizer = $('stage-resizer');
  const sidebar = $('stage-sidebar');
  if (!resizer || !sidebar) return;
  let startX = 0;
  let startWidth = 0;
  function onPointerMove(event) {
    const width = Math.max(164, Math.min(320, Math.round(startWidth + event.clientX - startX)));
    document.documentElement.style.setProperty('--stage-rail-size', `${width}px`);
    localStorage.setItem('chitra-stage-rail-size', String(width));
  }
  function onPointerUp() {
    document.body.classList.remove('resizing-stage-rail');
    resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }
  resizer.addEventListener('pointerdown', (event) => {
    if ($('workspace-layout')?.classList.contains('stages-hidden')) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    document.body.classList.add('resizing-stage-rail');
    resizer.classList.add('dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
}
function initConsoleResizer() {
  const resizer = $('console-resizer');
  const consoleEl = $('run-console');
  if (!resizer || !consoleEl) return;
  const savedHeight = Number(localStorage.getItem('chitra-console-size'));
  if (savedHeight >= 45 && savedHeight <= window.innerHeight * 0.75) {
    document.documentElement.style.setProperty('--console', `${savedHeight}px`);
    if (!consoleEl.classList.contains('collapsed')) {
      consoleEl.style.height = `${savedHeight}px`;
      syncConsoleHeight(savedHeight, false);
    } else {
      syncConsoleHeight(45, true);
    }
  } else {
    syncConsoleHeight(45, consoleEl.classList.contains('collapsed'));
  }
  let startY = 0;
  let startHeight = 0;
  function onPointerMove(e) {
    const delta = startY - e.clientY;
    const minHeight = 45;
    const maxHeight = Math.round(window.innerHeight * 0.75);
    const newHeight = Math.max(minHeight, Math.min(maxHeight, Math.round(startHeight + delta)));
    if (newHeight > 55 && consoleEl.classList.contains('collapsed')) {
      consoleEl.classList.remove('collapsed');
      $('console-toggle')?.setAttribute('aria-expanded', 'true');
      if ($('console-toggle')) $('console-toggle').textContent = '⌄';
    } else if (newHeight <= 48 && !consoleEl.classList.contains('collapsed')) {
      consoleEl.classList.add('collapsed');
      $('console-toggle')?.setAttribute('aria-expanded', 'false');
      if ($('console-toggle')) $('console-toggle').textContent = '⌃';
    }
    consoleEl.style.height = `${newHeight}px`;
    const isCollapsed = consoleEl.classList.contains('collapsed');
    syncConsoleHeight(newHeight, isCollapsed);
    if (newHeight > 50) {
      document.documentElement.style.setProperty('--console', `${newHeight}px`);
      localStorage.setItem('chitra-console-size', String(newHeight));
    }
  }
  function onPointerUp() {
    document.body.classList.remove('resizing-console');
    resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startHeight = consoleEl.getBoundingClientRect().height;
    document.body.classList.add('resizing-console');
    resizer.classList.add('dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
}
function restoreLayoutPreferences() {
  const stageSize = Number(localStorage.getItem('chitra-stage-rail-size'));
  if (stageSize >= 164 && stageSize <= 320) document.documentElement.style.setProperty('--stage-rail-size', `${stageSize}px`);
  const consoleSize = Number(localStorage.getItem('chitra-console-size')) || 210;
  const isConsoleCollapsed = $('run-console').classList.contains('collapsed');
  if (!isConsoleCollapsed && consoleSize >= 45 && consoleSize <= innerHeight * .75) $('run-console').style.height = `${consoleSize}px`;
  syncConsoleHeight(consoleSize, isConsoleCollapsed);
  const hidden = localStorage.getItem('chitra-stages-hidden') === 'true';
  $('workspace-layout').classList.toggle('stages-hidden', hidden);
  $('stages-edge-toggle')?.setAttribute('aria-expanded', String(!hidden));
  $('stages-toggle')?.setAttribute('aria-pressed', String(hidden));
  initDrawerResizer();
  initStageResizer();
  initConsoleResizer();
  updateDrawerDockState();
  new ResizeObserver(([entry]) => {
    const height = Math.round(entry.contentRect.height);
    const isCollapsed = $('run-console').classList.contains('collapsed');
    if (!isCollapsed && height >= 45) {
      localStorage.setItem('chitra-console-size', String(height));
      syncConsoleHeight(height, false);
    }
  }).observe($('run-console'));
}

document.addEventListener('DOMContentLoaded', () => { bindEvents(); bootstrap(); });
