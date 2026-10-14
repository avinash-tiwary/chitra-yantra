'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { Store } = require('./lib/store');
const { STAGES, STAGE_IDS, assertStageAndSubstage } = require('./lib/stages');
const { AGENTS, buildAdapter, inputHash, requiredOutputs } = require('./lib/adapters');
const { JobManager } = require('./lib/jobs');
const { AutomationController } = require('./lib/automation');
const { ResearchPipelineController } = require('./lib/research-pipeline');
const { coreClaimClearsVerification } = require('./lib/research-validation');
const { SCHEMA_VERSION, STAGE_DIRECTORIES, PATTERNS, ensureStructure, scanProject, iterationTarget, languageName } = require('./lib/project-schema');
const { planVersion, makeLegacyBlueprint, normaliseBlueprint, deriveAssetPlan, validateBlueprint, summary: blueprintSummary } = require('./lib/editorial-blueprint');
const { compileScreenStates } = require('./lib/screen-state-compiler');
const { latestPlan: latestAudioPlan, planVersion: audioPlanVersion, makePlan: makeAudioPlan, addCommentRevision } = require('./lib/audio-production');
const { PRIVATE_UPLOAD_THRESHOLD, validateQualityReport, buildReleaseManifest, verifyReleaseManifest } = require('./lib/release-contract');
const {
  assertId, assertProjectKey, parseProjectKey, assertRelativePath, resolveContained,
  randomToken, safeEqual, parseCookies,
} = require('./lib/security');

const APP_ROOT = __dirname;
const APP_VERSION = require('./package.json').version;
const PROJECT_ROOT = path.resolve(APP_ROOT, '..');
const CHANNELS_DIR = path.join(PROJECT_ROOT, 'channels');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_DIR = path.join(APP_ROOT, 'data');
const STATE_DIR = path.join(APP_ROOT, 'state');
const HOST = process.env.CHITRA_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7842);
const BODY_LIMIT = 1024 * 1024;
const AUDIO_UPLOAD_LIMIT = 32 * 1024 * 1024;
const DEFAULT_REFERENCE_AUDIO = path.join(PROJECT_ROOT, 'tools', 'tts_benchmark', 'reference', 'hindi_sample_style_c_emotional.wav');
const DEFAULT_REFERENCE_TRANSCRIPT = path.join(PROJECT_ROOT, 'tools', 'tts_benchmark', 'reference', 'hindi_sample_style_c_emotional.txt');
const HINDI_AWE_REFERENCE_AUDIO = path.join(PROJECT_ROOT, 'tools', 'tts_benchmark', 'reference', 'hindi_sample_style_a_awe.wav');
const HINDI_AWE_REFERENCE_TRANSCRIPT = path.join(PROJECT_ROOT, 'tools', 'tts_benchmark', 'reference', 'hindi_sample_style_a_awe.txt');
const ENGLISH_REFERENCE_AUDIO = path.join(PROJECT_ROOT, 'tools', 'tts_benchmark', 'reference', 'processed', 'english_sample_studio.wav');
const ENGLISH_REFERENCE_TRANSCRIPT = path.join(PROJECT_ROOT, 'tools', 'tts_benchmark', 'reference', 'english_sample.txt');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.srt', '.vtt', '.csv', '.yaml', '.yml']);
const FILESYSTEM_MANAGED_STAGES = new Set(['idea', 'research', 'script', 'assets', 'audio', 'visuals', 'qc', 'package']);
const DEFAULT_SCRIPT_QUALITY_THRESHOLD = 8.5;
const DEFAULT_SCRIPT_MAX_AUTO_REVISIONS = 4;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && process.env.CHITRA_ALLOW_REMOTE !== '1') {
  throw new Error('Remote binding is disabled. Set CHITRA_ALLOW_REMOTE=1 only behind an authenticated reverse proxy.');
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'chitra.db'), STATE_DIR);
const sessions = new Map();
const sockets = new Set();
const publicationByRun = new Map();
let automation = null;
let researchPipeline = null;

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, body, extraHeaders = {}) {
  securityHeaders(response);
  for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  const status = Number(error.statusCode) || (error.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error(error);
  sendJson(response, status, { error: status >= 500 ? 'Internal server error' : error.message, requestId: response.requestId });
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }); }
}

async function readBinaryBody(request, limit = AUDIO_UPLOAD_LIMIT) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Audio upload exceeds the 32 MB reference limit'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) throw Object.assign(new Error('Audio reference file is required'), { statusCode: 400 });
  return Buffer.concat(chunks);
}

function requestOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host && ['http:', 'https:'].includes(parsed.protocol);
  } catch { return false; }
}

function getSession(request) {
  const id = parseCookies(request.headers.cookie).chitra_session;
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt < Date.now()) return null;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireSession(request, { mutation = false } = {}) {
  if (!requestOriginAllowed(request)) throw Object.assign(new Error('Origin not allowed'), { statusCode: 403 });
  const session = getSession(request);
  if (!session) throw Object.assign(new Error('Session expired; reload the page'), { statusCode: 401 });
  if (mutation && !safeEqual(request.headers['x-csrf-token'], session.csrf)) {
    throw Object.assign(new Error('Invalid CSRF token'), { statusCode: 403 });
  }
  return session;
}

function projectPathForKey(projectKey, { mustExist = true } = {}) {
  const { channelId, slug } = parseProjectKey(projectKey);
  const channelRoot = resolveContained(CHANNELS_DIR, channelId, { mustExist: true });
  const videosRoot = resolveContained(channelRoot, 'videos', { mustExist: true });
  return resolveContained(videosRoot, slug, { mustExist });
}

function blueprintFiles(projectPath) {
  const plans = path.join(projectPath, '04_visuals', 'plans');
  if (!fs.existsSync(plans)) return [];
  return fs.readdirSync(plans)
    .filter((name) => /^editorial_blueprint_v\d+\.json$/i.test(name))
    .sort((left, right) => planVersion(left) - planVersion(right));
}

function readEditorialBlueprint(projectPath, project = {}, requestedVersion = null) {
  const files = blueprintFiles(projectPath);
  const filename = requestedVersion === null
    ? files.at(-1)
    : files.find((file) => planVersion(file) === requestedVersion);
  if (filename) {
    const relativePath = `04_visuals/plans/${filename}`;
    try {
      return { relativePath, legacy: false, blueprint: normaliseBlueprint(JSON.parse(fs.readFileSync(path.join(projectPath, relativePath), 'utf8')), { title: project.title, version: planVersion(filename) }) };
    } catch { return { relativePath, legacy: false, blueprint: null }; }
  }
  const scan = scanProject(projectPath);
  const planRelative = [...scan.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item));
  if (!planRelative) return { relativePath: null, legacy: false, blueprint: null };
  try {
    const assets = JSON.parse(fs.readFileSync(path.join(projectPath, planRelative), 'utf8'));
    return { relativePath: planRelative, legacy: true, blueprint: makeLegacyBlueprint(assets, { title: project.title, version: planVersion(planRelative), durationSeconds: Number(project.settings?.targetDurationMin || 0) * 60 }) };
  } catch { return { relativePath: planRelative, legacy: true, blueprint: null }; }
}

function conciseBlueprintBlockingProblems(blueprint) {
  const blocking = validateBlueprint(blueprint).filter((problem) => problem.severity === 'blocking');
  if (!blocking.length) return [];
  const cadence = blocking.filter((problem) => /timestamped internal screen states every 2–4 seconds/.test(problem.message));
  const other = blocking.filter((problem) => !cadence.includes(problem));
  const messages = [];
  if (cadence.length) {
    const sample = cadence.slice(0, 3).map((problem) => problem.beatId || 'unknown beat').join(', ');
    messages.push(`${cadence.length} visual-cadence violation(s): split long beats or add timestamped screen states every 2–4 seconds (for example: ${sample}${cadence.length > 3 ? ', …' : ''}).`);
  }
  if (other.length) {
    const sample = other.slice(0, 3).map((problem) => problem.message).join(' | ');
    messages.push(`${other.length} other Editorial Blueprint blocking issue(s): ${sample}${other.length > 3 ? ' | …' : ''}`);
  }
  return messages;
}

function writeBlueprintRevision({ projectKey, projectPath, project, blueprint, provenance = {} }) {
  const scan = scanProject(projectPath);
  const next = Math.max(0, scan.versions.assets || 0, ...blueprintFiles(projectPath).map(planVersion)) + 1;
  const versioned = normaliseBlueprint({ ...blueprint, version: next }, { title: project.title, version: next });
  const blueprintRelative = `04_visuals/plans/editorial_blueprint_v${next}.json`;
  const assetRelative = `04_visuals/plans/asset_plan_v${next}.json`;
  const blueprintContent = JSON.stringify(versioned, null, 2);
  const previousAssetRelative = [...scan.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item));
  let previousAssets = [];
  try { previousAssets = previousAssetRelative ? JSON.parse(fs.readFileSync(path.join(projectPath, previousAssetRelative), 'utf8')) : []; } catch { /* new blueprint */ }
  const previousById = new Map((Array.isArray(previousAssets) ? previousAssets : []).map((asset, index) => [asset.id || `ASSET_${String(index + 1).padStart(3, '0')}`, asset]));
  const catalog = deriveAssetPlan(versioned).map((asset) => {
    const old = previousById.get(asset.id) || {};
    const merged = { ...old, ...asset };
    for (const [key, value] of Object.entries(asset)) if (value === null && old[key] !== undefined) merged[key] = old[key];
    return merged;
  });
  const assetContent = JSON.stringify(catalog, null, 2);
  writeAtomic(path.join(projectPath, blueprintRelative), blueprintContent);
  writeAtomic(path.join(projectPath, assetRelative), assetContent);
  store.recordArtifact({ projectKey, stageId: 'assets', relativePath: blueprintRelative, content: blueprintContent, mimeType: 'application/json; charset=utf-8', provenance });
  store.recordArtifact({ projectKey, stageId: 'assets', relativePath: assetRelative, content: assetContent, mimeType: 'application/json; charset=utf-8', provenance: { ...provenance, derivedFrom: blueprintRelative } });
  return { blueprintRelative, assetRelative, blueprint: versioned };
}

function titleFromProject(projectPath, slug) {
  for (const file of ['README.md', 'VIDEO.md']) {
    try {
      const match = fs.readFileSync(path.join(projectPath, file), 'utf8').match(/^#\s+(.+)$/m);
      if (match) return match[1].trim().slice(0, 200);
    } catch { /* optional */ }
  }
  return slug.replaceAll('-', ' ');
}

function readChannel(channelId) {
  assertId(channelId, 'channel');
  const directory = resolveContained(CHANNELS_DIR, channelId, { mustExist: true });
  let metadata = {};
  for (const filename of ['channel_dna.json', 'channel.json']) {
    try { metadata = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')); break; } catch { /* try legacy name */ }
  }
  return { id: channelId, name: metadata.name || channelId, ...metadata };
}

function scanChannels() {
  if (!fs.existsSync(CHANNELS_DIR)) return [];
  return fs.readdirSync(CHANNELS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]*$/.test(entry.name)).map((entry) => {
    const channel = readChannel(entry.name);
    const videosDir = path.join(CHANNELS_DIR, entry.name, 'videos');
    const videos = fs.existsSync(videosDir) ? fs.readdirSync(videosDir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith('_') && /^[a-z0-9][a-z0-9_-]*$/.test(item.name))
      .map((item) => {
        const projectPath = path.join(videosDir, item.name);
        const projectKey = `${entry.name}__${item.name}`;
        store.ensureProject({ projectKey, channelId: entry.name, slug: item.name, title: titleFromProject(projectPath, item.name) });
        // The home screen is a project monitor, not a cached database browser. Reconcile
        // before presenting a status so work performed outside the studio is visible.
        const { project, filesystem } = syncFilesystemState(projectKey);
        const active = STAGES.find((stage) => ['running', 'queued'].includes(project.stages[stage.id]?.status));
        const attention = active || STAGES.find((stage) => ['needs_review', 'invalidated', 'failed'].includes(project.stages[stage.id]?.status));
        const diskUpdatedAt = fs.statSync(projectPath).mtime.toISOString();
        return { projectKey, slug: item.name, title: project.title, currentStage: active?.id || attention?.id || project.currentStage,
          status: (active || attention) ? project.stages[(active || attention).id].status : project.stages[project.currentStage]?.status || 'ready',
          updatedAt: diskUpdatedAt > project.updatedAt ? diskUpdatedAt : project.updatedAt, filesystem };
      }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
    return { ...channel, videos };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function stageForArtifact(relativePath) {
  if (relativePath.startsWith('00_project/')) return 'idea';
  if (relativePath.startsWith('01_research/')) return 'research';
  if (relativePath.startsWith('02_script/')) return 'script';
  if (relativePath.startsWith('03_audio/')) return 'audio';
  if (PATTERNS.assetPlan.test(relativePath) || relativePath.includes('/prompts/')) return 'assets';
  if (relativePath.startsWith('04_visuals/')) return 'visuals';
  if (PATTERNS.qc.test(relativePath) || relativePath === '05_edit/qc_report.json') return 'qc';
  if (relativePath.startsWith('05_edit/')) return 'assembly';
  if (relativePath.startsWith('06_publish/publication_') || relativePath.startsWith('06_publish/publish_request_') || relativePath.startsWith('06_publish/analytics/')) return 'publish';
  if (relativePath.startsWith('06_publish/')) return 'package';
  return null;
}

function walkFiles(root, relative = '') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(root, child));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

function indexableArtifact(relativePath) {
  if (relativePath.includes('/__pycache__/') || relativePath.includes('/chunks/') || relativePath.includes('/work/')) return false;
  if (/\.(?:py|pyc)$/i.test(relativePath)) return false;
  if (relativePath.startsWith('03_audio/voice/')) return false; // schema-v3 takes are indexed from 03_audio/takes/
  // Captured source payloads can be tens of megabytes. They remain durable on
  // disk and are represented by sources.json/excerpts; storing each raw PDF or
  // extracted full text again in SQLite would make research runs balloon the
  // application database.
  if (/^01_research\/corpus\/cycle_v\d+\/(?:raw|extracted)\//i.test(relativePath)) return false;
  if (/^01_research\/corpus\/(?:objects|parsed|index)\//i.test(relativePath)) return false;
  return true;
}

function visibleArtifacts(projectKey, stageId = null) {
  const projectPath = projectPathForKey(projectKey);
  // Revisions remain in SQLite for history/restore, but a removed on-disk file must
  // never remain actionable in the active artifact list.
  return store.listArtifacts(projectKey, stageId).filter((artifact) => indexableArtifact(artifact.relativePath)
    && fs.existsSync(path.join(projectPath, artifact.relativePath)));
}

function sourceTagCount(projectPath, relativePath) {
  try {
    return (fs.readFileSync(path.join(projectPath, relativePath), 'utf8').match(/^\[SOURCE:/gmi) || []).length;
  } catch { return 0; }
}

function productionScriptLanguages(project) {
  return [...new Set([
    languageName(project.settings?.scriptAuthoringLanguage || 'en'),
    languageName(project.settings?.language || 'hi'),
  ])];
}

// A factual audit belongs to the claims, not to their language. An adaptive
// branch can reuse its parent's audit only when it retains the editor-only
// source trail; a genuinely rewritten script still needs its own audit.
function factcheckCoverageForScriptVersion(projectKey, version) {
  const projectPath = projectPathForKey(projectKey);
  const artifacts = visibleArtifacts(projectKey, 'script');
  const hasReportFor = (language) => artifacts.some((artifact) => new RegExp(`^02_script/factcheck_v\\d+_${String(language).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\.md$`, 'i').test(artifact.relativePath));
  if (hasReportFor(version.language)) return { covered: true, inherited: false };

  const versions = new Map(store.listScriptVersions(projectKey).map((item) => [item.id, item]));
  const seen = new Set([version.id]);
  let child = version;
  let parent = child.parentId ? versions.get(child.parentId) : null;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (hasReportFor(parent.language)) {
      const parentSources = sourceTagCount(projectPath, parent.relativePath);
      const childSources = sourceTagCount(projectPath, child.relativePath);
      if (parentSources > 0 && childSources >= parentSources) {
        return { covered: true, inherited: true, from: parent.relativePath };
      }
      return { covered: false, reason: 'The adaptation no longer preserves the parent source trail.' };
    }
    child = parent;
    parent = child.parentId ? versions.get(child.parentId) : null;
  }
  return { covered: false, reason: 'No fact-check is attached to this script or its source branch.' };
}

function syncArtifacts(projectKey, stageId = null) {
  const projectPath = projectPathForKey(projectKey);
  ensureStructure(projectPath);
  const scriptLineage = store.getProject(projectKey)?.stages?.script?.data?.branchLineage || {};
  const parentIdFor = (relativePath) => {
    const parentPath = scriptLineage[relativePath]?.parentArtifact;
    return parentPath ? store.listScriptVersions(projectKey).find((version) => version.relativePath === parentPath)?.id || null : null;
  };
  const latest = new Map(store.listArtifacts(projectKey).map((artifact) => [artifact.relativePath, artifact]));
  const directories = [...new Set(Object.values(STAGE_DIRECTORIES).flat())];
  for (const directory of directories) {
    const full = path.join(projectPath, directory);
    if (!fs.existsSync(full)) continue;
    for (const nested of walkFiles(full)) {
        const relativePath = path.posix.join(directory, nested);
        if (!indexableArtifact(relativePath)) continue;
        const id = stageForArtifact(relativePath);
        if (!id || (stageId && id !== stageId)) continue;
        const file = resolveContained(projectPath, relativePath, { mustExist: true });
        const stat = fs.statSync(file);
        if (!stat.size) continue;
        const known = latest.get(relativePath);
        if (known?.size === stat.size && Number(known.provenance?.mtimeMs || 0) >= stat.mtimeMs) continue;
        const buffer = fs.readFileSync(file);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const mimeType = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        if (latest.get(relativePath)?.sha256 === sha256) {
          store.hydrateArtifactContent(latest.get(relativePath).id, buffer, mimeType);
          store.markArtifactObserved(latest.get(relativePath).id, stat.mtimeMs);
          continue;
        }
        const record = store.recordArtifact({ projectKey, stageId: id, relativePath, content: buffer, mimeType, provenance: { discovered: true, mtimeMs: stat.mtimeMs } });
        if (id === 'script' && /\.md$/i.test(relativePath) && /(?:outline|draft|script|final)_v\d+_/i.test(relativePath)) {
          const language = relativePath.match(/_v\d+_([a-z][a-z0-9-]*)\.md$/i)?.[1] || 'hi';
          const kind = /(?:^|\/)final_/i.test(relativePath) ? 'final' : /(?:^|\/)outline_/i.test(relativePath) ? 'outline' : 'draft';
          store.upsertScriptVersion({ projectKey, relativePath, parentId: parentIdFor(relativePath), language, kind, status: kind === 'final' ? 'ready' : 'draft' });
        }
        latest.set(relativePath, { ...record, sha256 });
    }
  }
  if (!stageId || stageId === 'script') {
    for (const artifact of visibleArtifacts(projectKey, 'script')) {
      if (!/\.md$/i.test(artifact.relativePath) || !/(?:outline|draft|script|final)_v\d+_/i.test(artifact.relativePath)) continue;
      const language = artifact.relativePath.match(/_v\d+_([a-z][a-z0-9-]*)\.md$/i)?.[1] || 'hi';
      const kind = /(?:^|\/)final_/i.test(artifact.relativePath) ? 'final' : /(?:^|\/)outline_/i.test(artifact.relativePath) ? 'outline' : 'draft';
      store.upsertScriptVersion({ projectKey, relativePath: artifact.relativePath, parentId: parentIdFor(artifact.relativePath), language, kind, status: kind === 'final' ? 'ready' : 'draft' });
    }
  }
  return visibleArtifacts(projectKey, stageId);
}

function syncFilesystemState(projectKey) {
  const projectPath = projectPathForKey(projectKey);
  ensureStructure(projectPath);
  syncArtifacts(projectKey);
  const filesystem = scanProject(projectPath);
  let project = store.getProject(projectKey);
  // A gate is only trustworthy while its required on-disk contract is present.
  // Do this before recognizing new material, so deletion cannot leave an approved
  // stage (and therefore its dependents) incorrectly unlocked.
  for (const stage of STAGES) {
    // Publishing is an explicit external-release decision, not an artifact
    // directory. Do not invalidate a released project because no local
    // `publish` filesystem contract exists.
    if (stage.id === 'publish') continue;
    const current = project.stages[stage.id];
    if (!filesystem.valid[stage.id] && ['approved', 'needs_review'].includes(current.status)) {
      store.patchStage(projectKey, stage.id, { status: 'invalidated', data: {
        filesystemInvalidatedAt: new Date().toISOString(),
        filesystemInvalidatedReason: 'Required filesystem artifacts are missing or no longer valid',
      } });
    }
  }
  project = store.getProject(projectKey);
  for (const stage of STAGES) {
    if (stage.id === 'publish') continue;
    const current = project.stages[stage.id];
    if (filesystem.valid[stage.id] && ['blocked', 'ready', 'failed', 'changes_requested', 'invalidated'].includes(current.status)) {
      store.patchStage(projectKey, stage.id, { status: 'needs_review', data: { filesystemRecognizedAt: new Date().toISOString() } });
    }
  }
  return { project: store.getProject(projectKey), filesystem };
}

function broadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    try { socket.send(data); }
    catch { sockets.delete(socket); socket.terminate(); }
  }
}

const jobs = new JobManager({
  store, logsDir: path.join(DATA_DIR, 'logs'), projectPathForKey, maxConcurrent: Math.min(10, Math.max(1, Number(process.env.CHITRA_MAX_JOBS) || 4)),
  onEvent(type, payload) {
    let researchRouting = null;
    if (type === 'job') {
      const project = store.getProject(payload.projectKey);
      const currentSubstages = project?.stages?.[payload.stageId]?.data?.substageStatus || {};
      if (project) store.patchStage(payload.projectKey, payload.stageId, { data: { substageStatus: { ...currentSubstages, [payload.substage]: payload.status } } });
      if (['needs_review', 'failed', 'cancelled', 'interrupted'].includes(payload.status)) {
        try { syncArtifacts(payload.projectKey, payload.stageId); } catch (error) { console.warn('[artifact sync]', error.message); }
        if (payload.stageId === 'research' && researchPipeline) researchRouting = researchPipeline.onJob(payload);
        if (payload.stageId === 'publish' && payload.status === 'needs_review') finalizePublication(payload);
        if (payload.stageId === 'publish' && ['failed', 'cancelled'].includes(payload.status)) {
          const publicationId = publicationByRun.get(payload.id);
          if (publicationId) {
            store.finishPublication(publicationId, { status: payload.status, error: payload.error || humanStatusForLog(payload.status) });
            publicationByRun.delete(payload.id);
            broadcast('publication', { projectKey: payload.projectKey, publications: store.listPublications(payload.projectKey) });
          }
        }
        const refreshed = store.getProject(payload.projectKey);
        const stage = STAGES.find((item) => item.id === payload.stageId);
        const currentIndex = stage?.substages.indexOf(payload.substage) ?? -1;
        const workflowAutomation = automation?.activeFor(payload.projectKey);
        const pendingAudioRevision = refreshed?.stages?.audio?.data?.pendingAudioRevision;
        if (!workflowAutomation && !refreshed?.stages?.audio?.autoMode && payload.status === 'needs_review' && payload.stageId === 'audio' && pendingAudioRevision?.runId === payload.id) {
          const next = payload.substage === 'voice' && pendingAudioRevision.scope === 'both' ? 'music'
            : payload.substage === 'music' ? 'mix' : null;
          if (next) {
            const nextRevision = { ...pendingAudioRevision, runId: null, phase: next };
            store.patchStage(payload.projectKey, 'audio', { data: { pendingAudioRevision: nextRevision } });
            setImmediate(() => {
              try {
                const run = queueStageRun({ projectKey: payload.projectKey, stageId: 'audio', substage: next, adapter: 'python',
                  iterationNote: `Follow-up for audio revision ${pendingAudioRevision.id}`, skipRequirementsCheck: true });
                store.patchStage(payload.projectKey, 'audio', { data: { pendingAudioRevision: { ...nextRevision, runId: run.id } } });
              } catch (error) { store.patchStage(payload.projectKey, 'audio', { status: 'needs_review', data: { pendingAudioRevision: { ...nextRevision, queueError: error.message } } }); }
            });
          }
        }
        const scriptGateRun = payload.status === 'needs_review' && payload.stageId === 'script'
          && ['author', 'draft', 'factcheck', 'critic'].includes(payload.substage) && refreshed?.stages?.script?.autoMode;
        if (!workflowAutomation && scriptGateRun) {
          const queueScriptGateRun = (substage, options = {}) => setImmediate(() => {
            try {
              const parentArtifact = options.parentArtifact || latestScriptParent(payload.projectKey);
              queueStageRun({ projectKey: payload.projectKey, stageId: 'script', substage, adapter: options.adapter || payload.adapter,
                parentArtifact, language: scriptLanguageFromArtifact(parentArtifact), iterationNote: options.iterationNote || '' });
            } catch (error) { store.patchStage(payload.projectKey, 'script', { status: 'failed', data: { autoChainError: error.message } }); }
          });
          if (['author', 'draft'].includes(payload.substage)) {
            store.patchStage(payload.projectKey, 'script', { status: 'needs_review', data: {
              ...(refreshed.stages.script?.data || {}),
              autoAuthoringCompletedAt: payload.substage === 'author' ? new Date().toISOString() : refreshed.stages.script?.data?.autoAuthoringCompletedAt,
              qualityGateState: 'factcheck_pending',
            } });
            queueScriptGateRun('factcheck');
          } else if (payload.substage === 'factcheck') {
            const factcheck = scriptFactcheckNeedsRepair(payload.projectKey);
            if (factcheck.blocking) {
              const projectAfterFactcheck = store.getProject(payload.projectKey);
              const attempts = Number(projectAfterFactcheck?.stages?.script?.data?.autoRevisionAttempts || 0);
              const maximum = Number(projectAfterFactcheck?.settings?.scriptMaxAutoRevisions || DEFAULT_SCRIPT_MAX_AUTO_REVISIONS);
              if (attempts >= maximum) {
                store.patchStage(payload.projectKey, 'script', { status: 'needs_review', data: { autopilotPaused: `Fact-check still has blocking findings after ${maximum} revision cycles: ${factcheck.summary}`, qualityGateState: 'human_review_required', autoRevisionAttempts: attempts } });
                broadcast('autopilot_paused', { projectKey: payload.projectKey, stageId: 'script', message: 'Script fact-check did not clear within the revision limit.' });
              } else {
                store.patchStage(payload.projectKey, 'script', { data: { autoRevisionAttempts: attempts + 1, lastAutoRevisionFinding: factcheck.summary, qualityGateState: 'revision_required' } });
                queueScriptGateRun('draft', { iterationNote: `Revision ${attempts + 1}/${maximum}: remove or qualify every fact-check finding. Do not retain unsupported claims. Findings: ${factcheck.summary}` });
              }
            } else {
              store.patchStage(payload.projectKey, 'script', { data: { qualityGateState: 'independent_critique_pending' } });
              queueScriptGateRun('critic', { adapter: payload.adapter === 'python' ? 'codex' : payload.adapter });
            }
          } else {
            const critique = scriptCritiqueGate(payload.projectKey);
            if (critique.passed) {
              try {
                approveCurrentScripts(payload.projectKey);
                store.patchStage(payload.projectKey, 'script', { status: 'needs_review', data: {
                  ...(store.getProject(payload.projectKey)?.stages?.script?.data || {}), qualityGateState: 'passed', scriptQualityGate: critique,
                } });
                if (refreshed?.settings?.autopilot) setImmediate(() => advanceAutopilot(payload.projectKey, 'script'));
              } catch (error) { store.patchStage(payload.projectKey, 'script', { status: 'failed', data: { autoChainError: error.message } }); }
            } else {
              const projectAfterCritique = store.getProject(payload.projectKey);
              const attempts = Number(projectAfterCritique?.stages?.script?.data?.autoRevisionAttempts || 0);
              const maximum = Number(projectAfterCritique?.settings?.scriptMaxAutoRevisions || DEFAULT_SCRIPT_MAX_AUTO_REVISIONS);
              if (attempts >= maximum) {
                store.patchStage(payload.projectKey, 'script', { status: 'needs_review', data: { autopilotPaused: `Independent critic did not clear the ${critique.threshold}/10 gate after ${maximum} revision cycles: ${critique.summary}`, qualityGateState: 'human_review_required', scriptQualityGate: critique, autoRevisionAttempts: attempts } });
                broadcast('autopilot_paused', { projectKey: payload.projectKey, stageId: 'script', message: 'Independent script critic did not clear the quality gate within the revision limit.' });
              } else {
                store.patchStage(payload.projectKey, 'script', { data: { autoRevisionAttempts: attempts + 1, lastAutoRevisionFinding: critique.summary, qualityGateState: 'revision_required', scriptQualityGate: critique } });
                queueScriptGateRun('draft', { iterationNote: `Revision ${attempts + 1}/${maximum}: independently graded ${critique.overallScore}/10; gate is ${critique.threshold}/10. Fix only the concrete critic findings below while retaining supported material.\n${critique.revisionBrief}` });
              }
            }
          }
        } else if (payload.stageId !== 'research' && !workflowAutomation && payload.status === 'needs_review' && refreshed?.stages?.[payload.stageId]?.autoMode && payload.substage !== 'author' && currentIndex >= 0 && currentIndex < stage.substages.length - 1) {
          const nextSubstage = stage.substages[currentIndex + 1];
          setImmediate(() => {
            try {
              const parentArtifact = payload.stageId === 'script' && ['analyze', 'factcheck', 'final'].includes(nextSubstage)
                ? latestScriptParent(payload.projectKey) : undefined;
              queueStageRun({ projectKey: payload.projectKey, stageId: payload.stageId, substage: nextSubstage, adapter: payload.adapter, parentArtifact,
                language: payload.stageId === 'script' ? scriptLanguageFromArtifact(parentArtifact, scriptAuthoringLanguage(refreshed)) : undefined });
            }
            catch (error) {
              store.patchStage(payload.projectKey, payload.stageId, { status: 'failed', data: { autoChainError: error.message } });
              broadcast('stage_error', { projectKey: payload.projectKey, stageId: payload.stageId, message: error.message });
            }
          });
        }
        if (payload.status === 'needs_review' && payload.stageId === 'research' && payload.substage === 'remediate') {
          const problems = validateStageForApproval(payload.projectKey, 'research');
          if (!problems.length) {
            const approved = store.approve({ projectKey: payload.projectKey, stageId: 'research', decision: 'approved', note: 'Research auto-approved after deterministic verification and remediation' });
            broadcast('project_updated', { projectKey: payload.projectKey, project: approved });
          } else {
            store.patchStage(payload.projectKey, 'research', { status: 'needs_review', data: { researchGateProblems: problems } });
          }
        }
        if (!workflowAutomation && !scriptGateRun && payload.status === 'needs_review' && refreshed?.settings?.autopilot && currentIndex === stage?.substages.length - 1) {
          setImmediate(() => advanceAutopilot(payload.projectKey, payload.stageId));
        }
      }
    }
    if (!researchRouting?.handled) automation?.onJob({ type, ...payload, ...(researchRouting?.payload || {}) });
    broadcast(type, payload);
  },
});
function finalizePublication(run) {
  const publicationId = publicationByRun.get(run.id);
  if (!publicationId) return;
  const projectPath = projectPathForKey(run.projectKey);
  const resultFile = path.join(projectPath, '06_publish', `publication_result_${publicationId}.json`);
  try {
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (!result.success) throw new Error(result.error || 'YouTube upload failed');
    const videoId = String(result.video_id || '');
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('YouTube returned an invalid video identifier');
    const videoUrl = `https://youtu.be/${videoId}`;
    const sidecarFailures = (result.operations || []).filter((operation) => !operation.success);
    if (result.complete === false || sidecarFailures.length) {
      const error = sidecarFailures.map((operation) => `${operation.operation}: ${operation.error}`).join('; ') || 'One or more post-upload operations need attention';
      store.finishPublication(publicationId, { status: 'uploaded_partial', remoteId: videoId, remoteUrl: videoUrl, error });
      store.patchStage(run.projectKey, 'publish', { status: 'needs_review', data: { videoId, videoUrl, sidecarFailures } });
    } else {
      store.finishPublication(publicationId, { status: 'uploaded', remoteId: videoId, remoteUrl: videoUrl });
      store.patchStage(run.projectKey, 'publish', { status: 'approved', data: { videoId, videoUrl } });
    }
  } catch (error) {
    store.finishPublication(publicationId, { status: 'failed', error: error.message });
    store.patchStage(run.projectKey, 'publish', { status: 'failed' });
  }
  broadcast('publication', { projectKey: run.projectKey, publications: store.listPublications(run.projectKey) });
  publicationByRun.delete(run.id);
}

function humanStatusForLog(status) {
  return status === 'cancelled' ? 'Upload cancelled' : 'Upload process failed';
}

function autopilotAdapter(project, stageId) {
  const configured = project.stages[stageId]?.data?.workerOverrideEnabled ? project.stages[stageId]?.agent : project.settings?.defaultAgent;
  if (configured && AGENTS[configured] && (AGENTS[configured].stages.includes('*') || AGENTS[configured].stages.includes(stageId))) return configured;
  return AGENTS.python.stages.includes(stageId) ? 'python' : 'codex';
}

function latestScriptParent(projectKey) {
  const files = visibleArtifacts(projectKey, 'script').filter((artifact) => /(?:draft|script|final)_v\d+_/i.test(artifact.relativePath));
  const version = (artifact) => Number(artifact.relativePath.match(/_v(\d+)_/i)?.[1] || 0);
  return files.sort((left, right) => version(right) - version(left) || right.revision - left.revision)[0]?.relativePath || null;
}

function scriptLanguageFromArtifact(relativePath, fallback = 'en') {
  return String(relativePath || '').match(/_v\d+_([a-z][a-z0-9-]*)\.md$/i)?.[1] || fallback;
}

function scriptAuthoringLanguage(project) {
  const channel = readChannel(project.channelId);
  return String(project.settings?.scriptAuthoringLanguage || channel.script_authoring_language || 'en').toLowerCase();
}

function visibleScriptVersions(projectKey) {
  const versions = store.listScriptVersions(projectKey);
  // Legacy “final” files were copied approval artefacts. Keep one visible only
  // for old projects that have no authored revision in that language.
  return versions.filter((version) => version.kind !== 'final'
    || !versions.some((candidate) => candidate.kind !== 'final' && candidate.kind !== 'outline' && candidate.language === version.language));
}

function approveCurrentScripts(projectKey, selectedVersionId = '') {
  const project = store.getProject(projectKey);
  const versions = visibleScriptVersions(projectKey).filter((version) => version.kind !== 'outline');
  if (!versions.length) throw Object.assign(new Error('Create a script before approving it'), { statusCode: 409 });
  const selected = versions.find((version) => version.id === selectedVersionId) || null;
  const newestByLanguage = new Map();
  for (const version of versions) {
    const current = newestByLanguage.get(version.language);
    if (!current || String(version.createdAt) > String(current.createdAt)) newestByLanguage.set(version.language, version);
  }
  const approvedScriptPaths = Object.fromEntries([...newestByLanguage.entries()].map(([language, version]) => [language, version.relativePath]));
  const authoringLanguage = languageName(project.settings?.scriptAuthoringLanguage || 'en');
  const canonical = newestByLanguage.get(authoringLanguage) || selected || [...newestByLanguage.values()][0];
  const currentData = project.stages.script?.data || {};
  store.patchStage(projectKey, 'script', { data: {
    ...currentData,
    approvedScriptPaths,
    approvedScriptVersionIds: Object.fromEntries([...newestByLanguage.entries()].map(([language, version]) => [language, version.id])),
    canonicalScriptPath: canonical.relativePath,
    selectedScriptVersionId: canonical.id,
    selectedScriptPath: canonical.relativePath,
    scriptApproval: { approvedAt: new Date().toISOString(), canonicalVersionId: canonical.id, versions: [...newestByLanguage.values()].map((version) => version.id) },
  } });
  return { project: store.getProject(projectKey), versions: [...newestByLanguage.values()], canonical };
}

function scriptFactcheckNeedsRepair(projectKey) {
  const report = visibleArtifacts(projectKey, 'script').filter((artifact) => /^02_script\/factcheck_v\d+_/i.test(artifact.relativePath)).at(-1);
  if (!report) return { blocking: true, summary: 'No fact-check report was produced.' };
  try {
    const content = fs.readFileSync(path.join(projectPathForKey(projectKey), report.relativePath), 'utf8');
    const flagged = (content.match(/\b(?:UNSOURCED|UNVERIFIED)\b/gi) || []).length;
    return { blocking: flagged > 0, summary: flagged ? `${flagged} unsupported or unverified finding(s)` : '' };
  } catch { return { blocking: true, summary: 'The fact-check report could not be read.' }; }
}

function scriptCritiqueGate(projectKey) {
  const project = store.getProject(projectKey);
  const thresholdSetting = Number(project?.settings?.scriptQualityThreshold);
  const threshold = Number.isFinite(thresholdSetting) ? Math.min(10, Math.max(0, thresholdSetting)) : DEFAULT_SCRIPT_QUALITY_THRESHOLD;
  const scriptDirectory = path.join(projectPathForKey(projectKey), '02_script');
  const reports = fs.existsSync(scriptDirectory) ? fs.readdirSync(scriptDirectory)
    .filter((file) => /^critique_v\d+_[a-z][a-z0-9-]*\.json$/i.test(file))
    .sort((left, right) => {
      const leftVersion = Number(left.match(/_v(\d+)_/i)?.[1] || 0);
      const rightVersion = Number(right.match(/_v(\d+)_/i)?.[1] || 0);
      return rightVersion - leftVersion || right.localeCompare(left);
    }) : [];
  if (!reports.length) return { passed: false, threshold, overallScore: 0, summary: 'No independent critic report was produced.', revisionBrief: 'Create a valid critic report before approving the script.' };
  try {
    const report = JSON.parse(fs.readFileSync(path.join(scriptDirectory, reports[0]), 'utf8'));
    const overallScore = Number(report.overallScore);
    const dimensions = report.dimensions && typeof report.dimensions === 'object' ? report.dimensions : {};
    const required = ['evidenceIntegrity', 'titlePromise', 'opening', 'narrative', 'spokenDelivery', 'visualStory', 'language'];
    const scores = Object.fromEntries(required.map((key) => [key, Number(dimensions[key]?.score)]));
    const missing = required.filter((key) => !Number.isFinite(scores[key]) || scores[key] < 0 || scores[key] > 10);
    const blockers = Array.isArray(report.blockers) ? report.blockers.filter(Boolean) : [];
    const revisionBrief = Array.isArray(report.revisionBrief) ? report.revisionBrief.filter(Boolean).join('\n') : String(report.revisionBrief || '').trim();
    const hardMinimumFailed = scores.evidenceIntegrity < 9 || required.filter((key) => key !== 'evidenceIntegrity').some((key) => scores[key] < 8);
    const passed = report.verdict === 'PASS' && Number.isFinite(overallScore) && overallScore >= threshold && !missing.length && !hardMinimumFailed && !blockers.length;
    const failures = [
      !Number.isFinite(overallScore) ? 'invalid overall score' : overallScore < threshold ? `overall score ${overallScore}/10 is below ${threshold}/10` : '',
      missing.length ? `missing or invalid dimensions: ${missing.join(', ')}` : '',
      hardMinimumFailed ? 'one or more required dimensions did not meet its hard minimum' : '',
      blockers.length ? `${blockers.length} unresolved blocker(s)` : '',
      report.verdict !== 'PASS' ? 'critic verdict is REVISE' : '',
    ].filter(Boolean);
    return { passed, threshold, overallScore: Number.isFinite(overallScore) ? overallScore : 0, dimensions: scores, blockers, reportPath: `02_script/${reports[0]}`,
      summary: passed ? `Independent critic passed at ${overallScore}/10.` : failures.join('; '),
      revisionBrief: revisionBrief || 'Use the critic report’s dimension evidence and blockers to make a targeted revision.' };
  } catch (error) {
    return { passed: false, threshold, overallScore: 0, summary: `Independent critic report could not be read: ${error.message}`, revisionBrief: 'Create valid JSON that follows the independent critic contract.' };
  }
}

function extractAutopilotIdea(projectPath) {
  const latest = scanProject(projectPath).stages.idea.files.at(-1);
  if (!latest) return null;
  const content = fs.readFileSync(path.join(projectPath, latest), 'utf8');
  const candidates = [...content.matchAll(/^###\s+(?:Idea\s+)?(\d+)[:.]?\s*(.+)$/gmi)].map((match, index, all) => {
    const block = content.slice(match.index, all[index + 1]?.index || content.length);
    const rating = (name) => Number(block.match(new RegExp(`${name}[:\\s]*(\\d+(?:\\.\\d+)?)`, 'i'))?.[1] || 0);
    const field = (names) => block.match(new RegExp(`\\*\\*(?:${names})[:\\*]*\\s*([\\s\\S]*?)(?=\\n(?:[-*]\\s*)?\\*\\*|\\n###|\\n##|$)`, 'i'))?.[1]?.trim() || '';
    return { index: Number(match[1]), title: match[2].replace(/\*+/g, '').trim(), pitch: field('Pitch|Premise'), angle: field('Angle|Core Tension|Narrative Angle'), whyNow: field('Why Now|Relevance'), visuals: field('Visuals|Visual Storytelling'), ratings: { tension: rating('Tension'), evidence: rating('Evidence'), visual: rating('Visual') }, score: rating('Evidence') * 2 + rating('Tension') + rating('Visual') };
  });
  if (!candidates.length) return null;
  return { ...candidates.sort((left, right) => right.score - left.score || left.index - right.index)[0], artifact: latest };
}

function autoSelectIdea(projectKey) {
  const project = store.getProject(projectKey);
  if (project.stages.idea?.data?.selectedIdea) return true;
  const projectPath = projectPathForKey(projectKey);
  const idea = extractAutopilotIdea(projectPath);
  if (!idea) return false;
  const selectedIdea = { index: idea.index, version: idea.artifact, title: idea.title, pitch: idea.pitch, angle: idea.angle, ratings: idea.ratings, whyNow: idea.whyNow, visuals: idea.visuals, selectedBy: 'autopilot' };
  store.patchStage(projectKey, 'idea', { data: { selectedIdea, selectedConcept: idea.pitch || idea.title, selectedTitle: idea.title, autopilotSelectionAt: new Date().toISOString() } });
  const brief = `# Project Brief: ${idea.title}\n\n**Selected Concept:** Idea ${idea.index} (${idea.artifact}) · selected by autopilot\n\n## Premise & Dramatic Conflict\n${idea.pitch || idea.title}\n\n## Narrative Angle & Tension\n${idea.angle || 'Evidence-led investigation'}\n\n## Contemporary Relevance\n${idea.whyNow}\n\n## Visual Storytelling Plan\n${idea.visuals}\n`;
  writeAtomic(path.join(projectPath, '00_project', 'project_brief.md'), brief);
  store.recordArtifact({ projectKey, stageId: 'idea', relativePath: '00_project/project_brief.md', content: brief, mimeType: 'text/markdown; charset=utf-8', provenance: { source: 'autopilot_selection', artifact: idea.artifact, index: idea.index } });
  if (project.title.startsWith('Untitled video') || project.title === project.slug) {
    const updated = store.updateProject(projectKey, { title: idea.title });
    const readme = path.join(projectPath, 'README.md');
    if (fs.existsSync(readme)) writeAtomic(readme, fs.readFileSync(readme, 'utf8').replace(/^#\s+.+$/m, `# ${updated.title}`));
  }
  return true;
}

function advanceAutopilot(projectKey, completedStageId) {
  const project = store.getProject(projectKey);
  if (!project?.settings?.autopilot) return;
  const stage = STAGES.find((item) => item.id === completedStageId);
  if (!stage || stage.id === 'publish') return;
  if (stage.id === 'idea' && !autoSelectIdea(projectKey)) {
    store.patchStage(projectKey, 'idea', { status: 'needs_review', data: { autopilotPaused: 'No parseable idea was produced; choose a direction manually.' } });
    broadcast('autopilot_paused', { projectKey, stageId: 'idea', message: 'Autopilot needs a parseable idea selection.' });
    return;
  }
  if (stage.id === 'script' && !Object.keys(project.stages.script?.data?.approvedScriptPaths || {}).length) approveCurrentScripts(projectKey);
  const problems = validateStageForApproval(projectKey, completedStageId);
  if (problems.length) {
    store.patchStage(projectKey, completedStageId, { status: 'needs_review', data: { autopilotPaused: problems } });
    broadcast('autopilot_paused', { projectKey, stageId: completedStageId, message: problems.join('; ') });
    return;
  }
  const approved = store.approve({ projectKey, stageId: completedStageId, decision: 'approved', note: 'Autopilot approved a validated on-disk contract' });
  broadcast('project_updated', { projectKey, project: approved });
  const next = STAGES[STAGES.findIndex((item) => item.id === completedStageId) + 1];
  if (!next || next.id === 'publish') {
    if (next) store.patchStage(projectKey, next.id, { status: 'ready', data: { autopilotPaused: 'Publish always requires an explicit human confirmation.' } });
    broadcast('autopilot_paused', { projectKey, stageId: 'publish', message: 'Release is ready for human confirmation.' });
    return;
  }
  const refreshed = store.getProject(projectKey);
  try {
    ensureRequirements(refreshed, next);
    store.patchStage(projectKey, next.id, { autoMode: true });
    queueStageRun({ projectKey, stageId: next.id, substage: next.substages[0], adapter: autopilotAdapter(refreshed, next.id) });
  } catch (error) {
    store.patchStage(projectKey, next.id, { status: 'needs_review', data: { autopilotPaused: error.message } });
    broadcast('autopilot_paused', { projectKey, stageId: next.id, message: error.message });
  }
}

function ensureRequirements(project, stage) {
  const missing = stage.requires.filter((required) => project.stages[required]?.status !== 'approved');
  if (missing.length) throw Object.assign(new Error(`Approve required stage${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`), { statusCode: 409 });
}

function validateSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Object.assign(new Error('Settings must be an object'), { statusCode: 400 });
  const allowed = {};
  if (settings.targetDurationMin !== undefined) {
    const duration = Number(settings.targetDurationMin);
    if (!Number.isInteger(duration) || duration < 1 || duration > 240) throw Object.assign(new Error('Target duration must be an integer from 1 to 240 minutes'), { statusCode: 400 });
    allowed.targetDurationMin = duration;
  }
  if (settings.wordsPerMinute !== undefined) {
    const rate = Number(settings.wordsPerMinute);
    if (!Number.isInteger(rate) || rate < 60 || rate > 250) throw Object.assign(new Error('Speaking rate must be an integer from 60 to 250 WPM'), { statusCode: 400 });
    allowed.wordsPerMinute = rate;
  }
  if (settings.language !== undefined) {
    const language = String(settings.language);
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw Object.assign(new Error('Language must be a BCP 47 language code such as hi or en-US'), { statusCode: 400 });
    allowed.language = language;
  }
  if (settings.defaultAgent !== undefined) {
    if (!AGENTS[settings.defaultAgent]) throw Object.assign(new Error('Invalid default agent'), { statusCode: 400 });
    allowed.defaultAgent = settings.defaultAgent;
  }
  if (settings.researchRounds !== undefined) {
    const rounds = Number(settings.researchRounds);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 6) throw Object.assign(new Error('Research rounds must be an integer from 1 to 6'), { statusCode: 400 });
    allowed.researchRounds = rounds;
  }
  if (settings.researchMaxSources !== undefined) {
    const sources = Number(settings.researchMaxSources);
    if (!Number.isInteger(sources) || sources < 4 || sources > 50) throw Object.assign(new Error('Research source budget must be an integer from 4 to 50'), { statusCode: 400 });
    allowed.researchMaxSources = sources;
  }
  if (settings.researchMaxAngles !== undefined) {
    const angles = Number(settings.researchMaxAngles);
    if (!Number.isInteger(angles) || angles < 3 || angles > 10) throw Object.assign(new Error('Maximum research angles must be an integer from 3 to 10'), { statusCode: 400 });
    allowed.researchMaxAngles = angles;
  }
  if (settings.researchMaxSynthesisPasses !== undefined) {
    const passes = Number(settings.researchMaxSynthesisPasses);
    if (!Number.isInteger(passes) || passes < 1 || passes > 3) throw Object.assign(new Error('Maximum synthesis passes must be an integer from 1 to 3'), { statusCode: 400 });
    allowed.researchMaxSynthesisPasses = passes;
  }
  if (settings.ownerReleaseTarget !== undefined) {
    const target = Number(settings.ownerReleaseTarget);
    if (!Number.isInteger(target) || target < 0 || target > 100) throw Object.assign(new Error('Owner release target must be an integer from 0 to 100'), { statusCode: 400 });
    allowed.ownerReleaseTarget = target;
  }
  if (settings.scriptQualityThreshold !== undefined) {
    const threshold = Number(settings.scriptQualityThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 10) throw Object.assign(new Error('Script quality threshold must be a number from 0 to 10'), { statusCode: 400 });
    allowed.scriptQualityThreshold = threshold;
  }
  if (settings.scriptMaxAutoRevisions !== undefined) {
    const revisions = Number(settings.scriptMaxAutoRevisions);
    if (!Number.isInteger(revisions) || revisions < 0 || revisions > 10) throw Object.assign(new Error('Script auto-revision limit must be an integer from 0 to 10'), { statusCode: 400 });
    allowed.scriptMaxAutoRevisions = revisions;
  }
  if (settings.autopilot !== undefined) allowed.autopilot = Boolean(settings.autopilot);
  if (settings.audioVoiceProfile !== undefined) {
    const profile = String(settings.audioVoiceProfile).trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(profile)) throw Object.assign(new Error('Audio voice profile must contain only letters, numbers, underscores, or hyphens'), { statusCode: 400 });
    allowed.audioVoiceProfile = profile;
  }
  return allowed;
}

function profilePath(projectPath, id) {
  return path.join(projectPath, '03_audio', 'references', id, 'profile.json');
}

function readAudioProfiles(projectPath) {
  const root = path.join(projectPath, '03_audio', 'references');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    try { return JSON.parse(fs.readFileSync(profilePath(projectPath, entry.name), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((left, right) => String(left.language).localeCompare(String(right.language)));
}

function ensureDefaultAudioProfiles(projectPath, projectKey = null) {
  const configs = [
    {
      id: 'hindi-default',
      language: 'hindi',
      audio: DEFAULT_REFERENCE_AUDIO,
      transcript: DEFAULT_REFERENCE_TRANSCRIPT,
      filename: 'hindi_sample_style_c_emotional.wav',
      label: 'Hindi voice sample (Emotional Depth — Master)',
      sharedReference: false,
      isDefault: true,
    },
    {
      id: 'hindi-awe',
      language: 'hindi',
      audio: HINDI_AWE_REFERENCE_AUDIO,
      transcript: HINDI_AWE_REFERENCE_TRANSCRIPT,
      filename: 'hindi_sample_style_a_awe.wav',
      label: 'Hindi voice sample (Awe & Wonder — Master)',
      sharedReference: false,
      isDefault: false,
    },
    {
      id: 'english-default',
      language: 'english',
      audio: fs.existsSync(ENGLISH_REFERENCE_AUDIO) ? ENGLISH_REFERENCE_AUDIO : DEFAULT_REFERENCE_AUDIO,
      transcript: fs.existsSync(ENGLISH_REFERENCE_TRANSCRIPT) ? ENGLISH_REFERENCE_TRANSCRIPT : DEFAULT_REFERENCE_TRANSCRIPT,
      filename: fs.existsSync(ENGLISH_REFERENCE_AUDIO) ? 'english_sample_studio.wav' : 'hindi_sample_style_c_emotional.wav',
      label: 'English voice sample',
      sharedReference: !fs.existsSync(ENGLISH_REFERENCE_AUDIO),
      isDefault: true,
    },
  ];

  for (const config of configs) {
    if (!fs.existsSync(config.audio) || !fs.existsSync(config.transcript)) continue;
    const transcript = fs.readFileSync(config.transcript, 'utf8').trim();
    const id = config.id;
    const destination = path.join(projectPath, '03_audio', 'references', id);
    const profileFile = path.join(destination, 'profile.json');
    if (fs.existsSync(profileFile)) continue;
    fs.mkdirSync(destination, { recursive: true });
    const referencePath = `03_audio/references/${id}/reference.wav`;
    const transcriptPath = `03_audio/references/${id}/reference.txt`;
    fs.copyFileSync(config.audio, path.join(projectPath, referencePath));
    writeAtomic(path.join(projectPath, transcriptPath), `${transcript}\n`);
    const profile = {
      schemaVersion: 2,
      id,
      language: config.language,
      label: config.label,
      referencePath,
      transcriptPath,
      filename: config.filename,
      transcript,
      source: 'bundled_authorized_reference',
      sharedReference: config.sharedReference,
      isDefault: config.isDefault,
      consentRequired: true,
      updatedAt: new Date().toISOString(),
    };
    writeAtomic(profileFile, `${JSON.stringify(profile, null, 2)}\n`);
    if (projectKey) {
      store.recordArtifact({ projectKey, stageId: 'audio', relativePath: referencePath, content: fs.readFileSync(path.join(projectPath, referencePath)), mimeType: MIME['.wav'], provenance: { action: 'default_voice_profile', profileId: id } });
      store.recordArtifact({ projectKey, stageId: 'audio', relativePath: profile.transcriptPath, content: `${transcript}\n`, mimeType: MIME['.txt'], provenance: { action: 'default_voice_profile', profileId: id } });
    }
  }
  return readAudioProfiles(projectPath);
}

function existingVoiceProfile(projectPath, project = {}) {
  const profiles = readAudioProfiles(projectPath);
  const configured = project.settings?.audioVoiceProfile;
  if (configured) {
    const selected = profiles.find((profile) => profile.id === configured);
    if (selected) return selected;
  }
  if (profiles.length) return profiles.find((profile) => profile.language === languageName(project.settings?.language || 'hi')) || profiles[0];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(projectPath, '03_audio', 'audio_pipeline.json'), 'utf8'));
    const reference = String(config.voice?.reference_audio || '');
    const transcript = String(config.voice?.reference_text_file || '');
    if (!reference) return null;
    const resolved = path.resolve(PROJECT_ROOT, reference);
    if (!resolved.startsWith(`${PROJECT_ROOT}${path.sep}`) || !fs.existsSync(resolved)) return null;
    return { schemaVersion: 1, id: 'existing-authorized-clone', referencePath: reference, transcriptPath: transcript, filename: path.basename(reference), source: 'audio_pipeline.json', consentRequired: true };
  } catch { return null; }
}

function preferredNarrationScriptPath(project, projectPath, language) {
  const scripts = project.stages?.script?.data?.approvedScriptPaths || {};
  const approved = scripts[language];
  if (approved && fs.existsSync(resolveContained(projectPath, approved))) return approved;
  const selected = project.stages?.script?.data?.selectedScriptPath;
  if (selected && new RegExp(`_${language}\\.md$`, 'i').test(selected) && fs.existsSync(resolveContained(projectPath, selected))) return selected;
  const canonical = project.stages?.script?.data?.canonicalScriptPath;
  if (canonical && new RegExp(`_${language}\\.md$`, 'i').test(canonical) && fs.existsSync(resolveContained(projectPath, canonical))) return canonical;
  return scanProject(projectPath).stages.script.files
    .filter((file) => new RegExp(`^(?:02_script/)?(?:final|draft|script)_v\\d+_${language}\\.md$`, 'i').test(file))
    .sort((left, right) => Number(right.match(/_v(\d+)_/i)?.[1] || 0) - Number(left.match(/_v(\d+)_/i)?.[1] || 0))[0] || null;
}

// The Audio Studio owns the voice-profile selection, so requiring a hand-made
// pipeline file here made its primary action fail with an opaque 500.  Keep an
// existing file untouched (it may contain an intentionally tuned provider
// setup), but create the safe local Higgs configuration on first voice run.
function ensureVoicePipelineConfig({ projectKey, project, projectPath }) {
  const configPath = path.join(projectPath, '03_audio', 'audio_pipeline.json');
  const language = languageName(project.settings?.language || 'hi');
  const scriptPath = preferredNarrationScriptPath(project, projectPath, language);
  if (fs.existsSync(configPath)) {
    // Never retain a stale narration source after the approved Hindi revision
    // advances. Keep model/reference tuning intact; update only this binding.
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (scriptPath && existing.voice?.text_file !== path.join(projectPath, scriptPath)) {
      existing.voice = { ...existing.voice, text_file: path.join(projectPath, scriptPath) };
      writeAtomic(configPath, `${JSON.stringify(existing, null, 2)}\n`);
      store.recordArtifact({ projectKey, stageId: 'audio', relativePath: '03_audio/audio_pipeline.json', content: JSON.stringify(existing, null, 2), mimeType: MIME['.json'], provenance: { action: 'sync_narration_script', scriptPath } });
    }
    return configPath;
  }

  const profiles = ensureDefaultAudioProfiles(projectPath, projectKey);
  const selectedProfileId = project.settings?.audioVoiceProfile;
  const profile = profiles.find((item) => item.id === selectedProfileId)
    || profiles.find((item) => item.language === language)
    || profiles[0];
  if (!profile) throw Object.assign(new Error('Add an authorized voice reference before generating voiceover'), { statusCode: 409 });

  // Prefer the approved script in the project's narration language. The
  // canonical script can be English, and must not override an approved Hindi
  // adaptation merely because it was selected in Script Studio.
  if (!scriptPath || !fs.existsSync(resolveContained(projectPath, scriptPath))) {
    throw Object.assign(new Error('Approve or select a script before generating voiceover'), { statusCode: 409 });
  }

  const config = {
    schema_version: 1,
    voice: {
      python: '.venv_tts_benchmark/bin/python',
      script: 'tools/tts_benchmark/higgs_tts.py',
      model: 'tools/tts_benchmark/models/higgs',
      text_file: path.join(projectPath, scriptPath),
      reference_audio: path.join(projectPath, profile.referencePath),
      reference_text_file: path.join(projectPath, profile.transcriptPath),
      output: path.join(projectPath, '03_audio', 'takes', 'voiceover_v1.wav'),
      metadata: path.join(projectPath, '03_audio', 'takes', 'voiceover_v1.json'),
      chunk_dir: path.join(projectPath, '03_audio', 'takes', 'voiceover_v1_chunks'),
      max_chars: 320,
      temperature: 0.65,
      top_p: 0.9,
      top_k: 50,
      max_new_tokens: 2048,
      pause_ms: 100,
      retries: 3,
      fresh_process_batch_chunks: 6,
    },
    // Music has its own explicit provisioning path.  This placeholder keeps
    // the shared pipeline schema valid without implying a hosted backend.
    music: {},
  };
  writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  store.recordArtifact({ projectKey, stageId: 'audio', relativePath: '03_audio/audio_pipeline.json', content: JSON.stringify(config, null, 2), mimeType: MIME['.json'], provenance: { action: 'auto_voice_pipeline', profileId: profile.id, scriptPath } });
  return configPath;
}

// Music used to be left as an empty schema placeholder when the voice pipeline
// was first created.  That made the only Music Studio action permanently
// disabled: there is no separate UI where a user could fill in `script` and
// `manifest`.  Materialise the plan-derived music configuration on demand
// instead, supporting both ACE-Step 1.5 and YuE2-3B.
function ensureMusicPipelineConfig({ projectKey, project, projectPath, provider }) {
  let configPath = path.join(projectPath, '03_audio', 'audio_pipeline.json');
  let config = {};
  try {
    configPath = ensureVoicePipelineConfig({ projectKey, project, projectPath });
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    } else {
      fs.mkdirSync(path.join(projectPath, '03_audio'), { recursive: true });
      config = { schema_version: 1, voice: {}, music: {} };
      writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  }
  const planName = latestAudioPlan(projectPath);
  if (!planName) throw Object.assign(new Error('Create an audio plan before generating a soundtrack'), { statusCode: 409 });
  const planRelative = `03_audio/plans/${planName}`;
  const plan = JSON.parse(fs.readFileSync(path.join(projectPath, planRelative), 'utf8'));
  const sourceCues = Array.isArray(plan.musicCues)
    ? plan.musicCues
    : (Array.isArray(plan.cues) ? plan.cues.filter((cue) => cue.type === 'music') : []);
  if (!sourceCues.length) throw Object.assign(new Error('The audio plan has no music cues to generate'), { statusCode: 409 });

  // Read blueprint if available to calculate exact durationSeconds
  let blueprint = null;
  const bpDir = path.join(projectPath, '04_visuals', 'plans');
  if (fs.existsSync(bpDir)) {
    const bpFiles = fs.readdirSync(bpDir).filter((f) => f.startsWith('editorial_blueprint_') && f.endsWith('.json')).sort().reverse();
    if (bpFiles[0]) {
      try { blueprint = JSON.parse(fs.readFileSync(path.join(bpDir, bpFiles[0]), 'utf8')); } catch {}
    }
  }
  const cueTimings = new Map();
  if (blueprint && Array.isArray(blueprint.beats)) {
    for (const beat of blueprint.beats) {
      const m = beat.audio?.musicCueId;
      if (m) {
        const s = Number(beat.timing?.startSeconds || 0);
        const e = Number(beat.timing?.endSeconds || s);
        if (!cueTimings.has(m)) {
          cueTimings.set(m, { startSeconds: s, endSeconds: e });
        } else {
          const entry = cueTimings.get(m);
          entry.startSeconds = Math.min(entry.startSeconds, s);
          entry.endSeconds = Math.max(entry.endSeconds, e);
        }
      }
    }
  }

  const configured = config.music || {};
  const selectedProvider = provider || configured.provider || 'ace_step';
  const manifestRelative = '03_audio/plans/music_generation_manifest.json';
  const manifest = {
    schemaVersion: 1,
    provider: selectedProvider,
    sourcePlan: planRelative,
    cues: sourceCues.map((cue) => {
      const timing = cueTimings.get(cue.id);
      const calculatedDuration = timing ? Math.max(8, Math.round(timing.endSeconds - timing.startSeconds)) : Number(cue.durationSeconds || cue.duration || 30);
      return {
        id: String(cue.id),
        prompt: String(cue.brief || cue.prompt || cue.id),
        durationSeconds: Math.max(8, Math.min(180, calculatedDuration)),
        instrumental: true,
      };
    }),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeAtomic(path.join(projectPath, manifestRelative), manifestContent);
  store.recordArtifact({ projectKey, stageId: 'audio', relativePath: manifestRelative, content: manifestContent, mimeType: MIME['.json'], provenance: { action: 'sync_music_manifest', sourcePlan: planRelative, provider: selectedProvider } });

  const defaultApiUrl = selectedProvider === 'ace_step' && process.env.ACESTEP_API_URL
    ? process.env.ACESTEP_API_URL
    : (process.env.COMFY_API_URL || 'http://127.0.0.1:8188');
  const configuredBackend = process.env.COMFY_BACKEND_COMMAND && process.env.COMFY_BACKEND_CWD
    ? {
      command: process.env.COMFY_BACKEND_COMMAND.split(/\s+/).filter(Boolean),
      cwd: process.env.COMFY_BACKEND_CWD,
      log_file: process.env.COMFY_BACKEND_LOG || path.join(projectPath, '03_audio', 'music', 'backend.log'),
      startup_timeout: Number(process.env.COMFY_BACKEND_STARTUP_TIMEOUT || 240),
    }
    : null;

  if (!configured.script || configured.managedBy === 'chitra-yantra' || (provider && configured.provider !== provider)) {
    config.music = {
      ...configured,
      managedBy: 'chitra-yantra',
      provider: selectedProvider,
      python: process.env.PYTHON || 'python3',
      script: 'tools/acestep_music_runner.py',
      manifest: path.join(projectPath, manifestRelative),
      output_root: path.join(projectPath, '03_audio', 'music'),
      revision: `v${audioPlanVersion(planName) || 1}`,
      api_url: configured.api_url && configured.provider === selectedProvider ? configured.api_url : defaultApiUrl,
      timeout: Number(configured.timeout || 2400),
      ...(configuredBackend ? { backend: configuredBackend } : {}),
    };
    writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath: '03_audio/audio_pipeline.json', content: JSON.stringify(config, null, 2), mimeType: MIME['.json'], provenance: { action: 'auto_music_pipeline', sourcePlan: planRelative, provider: selectedProvider } });
  }
  return configPath;
}

function timestampedWorkspace() {
  const now = new Date();
  const part = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}`;
  return { slugBase: `video-${stamp}`, title: `Untitled video — ${stamp.slice(0, 10)} ${stamp.slice(11, 13)}:${stamp.slice(13)}` };
}

function createDatedWorkspace(channelId) {
  const channelRoot = resolveContained(CHANNELS_DIR, channelId, { mustExist: true });
  const videosRoot = resolveContained(channelRoot, 'videos', { mustExist: true });
  const identity = timestampedWorkspace();
  let slug = identity.slugBase;
  let suffix = 2;
  while (fs.existsSync(path.join(videosRoot, slug))) slug = `${identity.slugBase}-${String(suffix++).padStart(2, '0')}`;
  return { ...identity, slug, videosRoot, projectPath: resolveContained(videosRoot, slug) };
}

function moveProjectToChannel(projectKey, channelId) {
  const project = store.getProject(projectKey);
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  if (project.channelId === channelId) return project;
  if (store.listRuns(projectKey).some((run) => ['queued', 'running'].includes(run.status))) throw Object.assign(new Error('Stop the active run before moving this video to another channel'), { statusCode: 409 });
  const sourcePath = projectPathForKey(projectKey);
  const targetChannel = resolveContained(CHANNELS_DIR, channelId, { mustExist: true });
  const targetVideos = resolveContained(targetChannel, 'videos', { mustExist: true });
  const destinationPath = resolveContained(targetVideos, project.slug);
  if (fs.existsSync(destinationPath)) throw Object.assign(new Error('That channel already has a workspace with this timestamp'), { statusCode: 409 });
  const newProjectKey = `${channelId}__${project.slug}`;
  fs.renameSync(sourcePath, destinationPath);
  try { return store.moveProjectKey(projectKey, { newProjectKey, channelId }); }
  catch (error) {
    try { fs.renameSync(destinationPath, sourcePath); } catch { /* retain the original error */ }
    throw error;
  }
}

function queueStageRun({ projectKey, stageId, substage, adapter, customPrompt, manualSources, planningMode, topicDescription, iterationNote, parentArtifact, parentIndex, parentTitle, language, outputTarget, outputTargets, researchTask, skipRequirementsCheck = false }) {
  let project = store.getProject(projectKey);
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  const { stage, substage: selectedSubstage } = assertStageAndSubstage(stageId, substage);
  if (stage.id === 'publish') throw Object.assign(new Error('Use the confirmed publish action'), { statusCode: 400 });
  if (stage.id === 'idea' && (planningMode !== undefined || topicDescription !== undefined)) {
    const mode = planningMode === 'guided' ? 'guided' : 'proactive';
    store.patchStage(projectKey, 'idea', { data: { planningMode: mode, topicDescription: String(topicDescription || '').trim().slice(0, 20_000) } });
    project = store.getProject(projectKey);
  }
  if (!skipRequirementsCheck) {
    ensureRequirements(project, stage);
  }
  const projectPath = projectPathForKey(projectKey);
  const channel = readChannel(project.channelId);
  const stageOverride = project.stages[stage.id]?.data?.workerOverrideEnabled ? project.stages[stage.id]?.agent : null;
  let selectedAdapter = adapter || stageOverride || project.settings?.defaultAgent || 'codex';
  if (stage.id === 'script' && ['analyze', 'critic'].includes(selectedSubstage) && selectedAdapter === 'python') {
    selectedAdapter = 'codex';
  }
  if (stage.id === 'visuals' && (!adapter || selectedAdapter === 'codex')) {
    selectedAdapter = 'python';
  }
  if (stage.id === 'audio' && selectedSubstage === 'voice' && selectedAdapter === 'python') {
    ensureVoicePipelineConfig({ projectKey, project, projectPath });
    if (project.stages?.audio?.data?.narrationReview?.status !== 'approved') {
      throw Object.assign(new Error('Prepare and approve the narration review before generating voiceover'), { statusCode: 409 });
    }
  }
  if (stage.id === 'audio' && selectedSubstage === 'music' && selectedAdapter === 'python') {
    ensureMusicPipelineConfig({ projectKey, project, projectPath });
  }
  const selectedPrompt = customPrompt ?? project.stages[stage.id]?.promptOverride;
  const researcherNotes = manualSources ?? project.stages[stage.id]?.data?.manualSources;
  const outputLanguage = language || (stage.id === 'script' ? scriptAuthoringLanguage(project) : project.settings?.language || channel.script_language || 'hi');
  const iteration = outputTarget || (Array.isArray(outputTargets) && outputTargets.length)
    ? { target: outputTarget || outputTargets[0] }
    : iterationTarget(projectPath, stage.id, outputLanguage, selectedSubstage);

  if (stage.id === 'idea' && iteration.target) {
    const note = String(iterationNote || '');
    const detectedIndex = parentIndex !== undefined && parentIndex !== null ? Number(parentIndex) : (note.match(/rooted specifically in Idea (\d+)/i)?.[1] ? Number(note.match(/rooted specifically in Idea (\d+)/i)[1]) : null);
    if (detectedIndex !== null) {
      const currentData = project.stages.idea?.data || {};
      const branchLineage = { ...(currentData.branchLineage || {}) };
      branchLineage[iteration.target] = {
        parentArtifact: parentArtifact || '00_project/idea_v1.md',
        parentIndex: detectedIndex,
        parentTitle: parentTitle || topicDescription || '',
        createdAt: new Date().toISOString(),
      };
      store.patchStage(projectKey, 'idea', { data: { ...currentData, branchLineage } });
      project = store.getProject(projectKey);
    }
  }

  if (stage.id === 'script' && iteration.target && parentArtifact) {
    const currentData = project.stages.script?.data || {};
    const branchLineage = { ...(currentData.branchLineage || {}) };
    branchLineage[iteration.target] = { parentArtifact, language: outputLanguage, createdAt: new Date().toISOString() };
    store.patchStage(projectKey, 'script', { data: { branchLineage } });
    project = store.getProject(projectKey);
  }

  const commandProject = language ? { ...project, settings: { ...project.settings, language: outputLanguage } } : project;
  const commandSpec = buildAdapter({ appRoot: APP_ROOT, projectRoot: PROJECT_ROOT, projectPath, project: commandProject, channel, stageId: stage.id, substage: selectedSubstage, adapter: selectedAdapter, customPrompt: selectedPrompt, manualSources: researcherNotes, planningMode: project.stages?.idea?.data?.planningMode, outputTarget: iteration.target, outputTargets, iterationNote, parentArtifact, researchTask });
  return jobs.enqueue({ project, stageId: stage.id, substage: selectedSubstage, adapter: selectedAdapter, commandSpec, projectPath,
    resource: stage.id === 'audio' && ['voice', 'music'].includes(selectedSubstage) ? 'audio-model' : null,
    inputHash: inputHash({ project, stageId: stage.id, substage: selectedSubstage, adapter: selectedAdapter, customPrompt: selectedPrompt, manualSources: researcherNotes, researchTask }) });
}

function validateStageForApproval(projectKey, stageId) {
  const projectPath = projectPathForKey(projectKey);
  const project = store.getProject(projectKey);
  const stage = STAGES.find((item) => item.id === stageId);
  const problems = [];
  const filesystem = scanProject(projectPath);
  const requireFile = (relative, minSize = 2) => {
    const file = path.join(projectPath, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size < minSize) problems.push(`Missing or empty: ${relative}`);
    else if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) && fs.readFileSync(file, 'utf8').includes('{{')) problems.push(`Unresolved template markers: ${relative}`);
    return file;
  };
  for (const relative of stage.outputs) requireFile(relative, relative.endsWith('.mp4') || relative.endsWith('.wav') ? 1024 : 20);
  if (FILESYSTEM_MANAGED_STAGES.has(stageId) && !filesystem.valid[stageId]) problems.push(`No valid ${stage.convention || stage.name.toLowerCase()} artifact was recognized`);
  if (stageId === 'research') {
    const pipelineFiles = fs.existsSync(path.join(projectPath, '01_research'))
      ? fs.readdirSync(path.join(projectPath, '01_research')).filter((name) => /^research_pipeline_v\d+\.json$/.test(name)).sort((left, right) => Number(left.match(/v(\d+)/)?.[1]) - Number(right.match(/v(\d+)/)?.[1]))
      : [];
    const pipelineFile = pipelineFiles.at(-1);
    if (pipelineFile) {
      let pipeline;
      try { pipeline = JSON.parse(fs.readFileSync(path.join(projectPath, '01_research', pipelineFile), 'utf8')); }
      catch { return [...problems, 'Research pipeline manifest is invalid']; }
      const version = Number(pipeline.version || 0);
      if (pipeline.status !== 'completed') problems.push(`Research pipeline is ${pipeline.status || 'incomplete'}`);
      if (!Number.isInteger(pipeline.angleCount) || pipeline.angleCount < 3 || pipeline.angleCount > 10) problems.push('Research pipeline must contain 3-10 planned angles');
      if (!Number.isInteger(pipeline.synthesisPasses) || pipeline.synthesisPasses < 1 || pipeline.synthesisPasses > 3) problems.push('Research pipeline must contain 1-3 synthesis passes');
      for (const task of Object.values(pipeline.tasks || {})) {
        if (task.status !== 'completed') problems.push(`Research task ${task.substage || 'unknown'} is incomplete`);
        for (const relative of task.outputs || []) requireFile(relative, relative.endsWith('.json') ? 2 : 100);
      }
      const evidencePath = `01_research/dossiers/evidence_v${version}.md`;
      const coveragePath = `01_research/synthesis/coverage_v${version}.json`;
      const ledgerPath = `01_research/claims/claim_ledger_v${version}.json`;
      const verificationPath = `01_research/verification/verification_v${version}.md`;
      const productionPath = `01_research/dossiers/production_v${version}.md`;
      for (const relative of [pipeline.planPath, evidencePath, coveragePath, ledgerPath, verificationPath, productionPath]) {
        if (typeof relative !== 'string' || !relative) problems.push('Research pipeline references an invalid output path');
        else requireFile(relative, relative.endsWith('.json') ? 2 : 100);
      }
      try {
        const coverage = JSON.parse(fs.readFileSync(path.join(projectPath, coveragePath), 'utf8'));
        if (!Array.isArray(coverage.findings) || !coverage.findings.length) problems.push('Research coverage ledger has no findings');
      } catch { problems.push('Research coverage ledger is invalid'); }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(projectPath, ledgerPath), 'utf8'));
        const claims = Array.isArray(parsed) ? parsed : parsed.claims;
        if (!Array.isArray(claims) || !claims.length) throw new Error('empty');
        for (const claim of claims) {
          const verdict = String(claim.status || claim.verification?.verdict || claim.audit?.verdict || '').toLowerCase();
          const citations = Array.isArray(claim.citations) ? claim.citations.filter((citation) => citation?.url) : [];
          if (claim.class !== 'creative_bridge' && ['verified', 'qualified'].includes(claim.status) && !citations.length) problems.push(`Claim ${claim.id || 'unknown'} lacks a source link`);
          if (claim.class === 'core' && !coreClaimClearsVerification(claim)) problems.push(`Core claim ${claim.id || 'unknown'} did not clear verification`);
        }
      } catch { problems.push('Research claim ledger is missing or invalid'); }
      return problems;
    }
    const manifestPath = path.join(projectPath, '01_research', 'manifest.json');
    const sourceCatalog = path.join(projectPath, '01_research', 'corpus', 'sources.json');
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Number(manifest.schemaVersion) !== 2 || !Array.isArray(manifest.sources)) problems.push('Research manifest is missing source provenance');
      if (!Number(manifest.parsedSourceCount)) problems.push('Research needs at least one parsed source');
      // Approval can rely only on usable parsed sources. A failed URL must
      // never satisfy a role requirement merely because it was discovered.
      const roles = manifest.parsedSourceRoleCounts || manifest.sourceRoleCounts || {};
      const contract = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectPath, '01_research', 'contracts', 'research_contract.json'), 'utf8')); } catch { return {}; } })();
      if (!roles.primary_or_official && contract.primaryUnavailable !== true) problems.push('Research needs a primary or official source, or a documented primary-source unavailability decision');
      if (Number(roles.academic_or_authoritative || 0) < 2) problems.push('Research needs two academic or authoritative sources');
      if (!roles.counterview && contract.noDebateDecision !== true) problems.push('Research needs an independent counterview or documented no-debate decision');
    } catch { /* legacy projects receive the existing catalog check below */ }
    try {
      if (!manifest) {
        const sources = JSON.parse(fs.readFileSync(sourceCatalog, 'utf8'));
        const fetched = Array.isArray(sources.sources) ? sources.sources.filter((source) => source.status === 'fetched' && source.extractedPath) : [];
        if (!fetched.length) problems.push('Research needs at least one fetched and extracted source before approval');
      }
    } catch { if (!manifest) problems.push('Research source catalog is missing or invalid'); }
    if (manifest) {
      const version = filesystem.versions.research;
      const ledgerPath = path.join(projectPath, '01_research', 'claims', `claim_ledger_v${version}.json`);
      const verificationPath = path.join(projectPath, '01_research', 'verification', `verification_v${version}.md`);
      const productionPath = path.join(projectPath, '01_research', 'dossiers', `production_v${version}.md`);
      if (!fs.existsSync(ledgerPath)) problems.push('Research claim ledger is missing');
      if (!fs.existsSync(verificationPath)) problems.push('Research verification report is missing');
      if (!fs.existsSync(productionPath)) problems.push('Research production dossier is missing');
      try {
        const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        const claims = Array.isArray(parsed) ? parsed : parsed.claims;
        if (!Array.isArray(claims) || !claims.length) throw new Error('empty');
        for (const claim of claims) {
          const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
          const audit = claim.audit || {};
          if (claim.class !== 'creative_bridge' && !evidenceIds.length) problems.push(`Claim ${claim.id || 'unknown'} lacks evidence IDs`);
          if (claim.class === 'core' && (audit.blocking || audit.verdict !== 'entailed')) problems.push(`Core claim ${claim.id || 'unknown'} is not entailed by the audit`);
          if (claim.class === 'creative_bridge' && /\b\d{3,4}\b|\d+\s*(?:CE|BCE|AD|BC)|because|caused|resulted|led to/i.test(String(claim.claim || ''))) problems.push(`Creative bridge ${claim.id || 'unknown'} contains factual markers`);
        }
      } catch { problems.push('Research claim ledger is missing or invalid'); }
    }
  }
  if (stageId === 'script') {
    const approvedPaths = Object.values(project.stages.script?.data?.approvedScriptPaths || {});
    const versions = store.listScriptVersions(projectKey);
    if (!approvedPaths.length || !approvedPaths.some((relativePath) => versions.some((version) => version.relativePath === relativePath))) {
      problems.push('Approve at least one current script before continuing');
    }
  }
  if (stageId === 'assets') {
    const loaded = readEditorialBlueprint(projectPath, project);
    if (!loaded.blueprint || loaded.legacy) problems.push('A versioned Editorial Blueprint is required; regenerate the Assets stage to migrate the legacy asset plan.');
    else {
      problems.push(...conciseBlueprintBlockingProblems(loaded.blueprint));
    }
    const planRelative = [...filesystem.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item));
    if (!planRelative) problems.push('A render-compatible asset plan is required.');
    else {
      try { if (!Array.isArray(JSON.parse(fs.readFileSync(path.join(projectPath, planRelative), 'utf8')))) problems.push('Asset plan must be a JSON array'); } catch { problems.push('Asset plan is invalid JSON'); }
    }
  }
  if (stageId === 'audio') {
    const planName = latestAudioPlan(projectPath);
    if (!planName) problems.push('A versioned audio production plan is required');
    else {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(projectPath, '03_audio', 'plans', planName), 'utf8'));
        const cues = Array.isArray(plan.cues) ? plan.cues : plan.musicCues;
        if (Number(plan.schemaVersion) !== 1 || !Array.isArray(cues)) problems.push('Audio production plan is invalid');
        if ((plan.revisions || []).some((revision) => revision.status === 'open')) problems.push('Resolve every audio revision comment before approval');
      } catch { problems.push('Audio production plan is invalid'); }
    }
    const report = path.join(projectPath, '03_audio', 'mixes', `qc_audio_v${filesystem.versions.audio || 1}.json`);
    if (!fs.existsSync(report)) problems.push('Audio QC report is required before final approval');
    const review = project?.stages?.audio?.data?.narrationReview;
    if (!review || review.status !== 'approved') problems.push('Approved narration review is required before final approval');
    else if (review.manifest) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(projectPath, review.manifest), 'utf8'));
        if (manifest.narration_sha256 !== review.narrationSha256) problems.push('Narration review is stale; re-review the current compiled narration');
      } catch { problems.push('Approved narration manifest is unavailable'); }
    }
    if (Object.values(review?.chunkReviews || {}).some((item) => item?.status === 'changes_requested')) {
      problems.push('Resolve or approve every requested narration chunk retake before final approval');
    }
  }
  if (stageId === 'visuals') {
    const renders = path.join(projectPath, '04_visuals', 'renders');
    const images = fs.existsSync(renders) ? walkFiles(renders).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)) : [];
    if (!images.length) problems.push('No visual renders are available');
    try {
      const planRelative = [...filesystem.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item));
      const manifest = JSON.parse(fs.readFileSync(path.join(projectPath, planRelative || '04_visuals/plans/asset_plan_v1.json'), 'utf8'));
      const incomplete = manifest.filter((item) => item.approvalStatus !== 'approved' || (!(item.generatedPath || item.sourceUrl)) || (item.sourceUrl && !(item.license && item.attribution)));
      if (incomplete.length) problems.push(`${incomplete.length} visual asset(s) lack approval, a file/source, or rights metadata`);
    } catch { problems.push('Visual manifest is missing or invalid'); }
  }
  if (stageId === 'qc') {
    const file = path.join(projectPath, filesystem.stages.qc.files.at(-1) || '05_edit/qc_report_v1.json');
    if (!filesystem.valid.qc) problems.push('No valid versioned QC report was recognized');
    try {
      const checks = JSON.parse(fs.readFileSync(file, 'utf8')).checks || [];
      const technical = checks.filter((check) => !check.manual && check.id !== 'subtitles' && !check.passed);
      if (technical.length) problems.push(`${technical.length} technical QC check(s) failed`);
      const manual = checks.filter((check) => check.manual);
      const saved = project.stages.qc?.data?.manualChecks || {};
      if (manual.some((check) => !saved[check.id])) problems.push('Complete every manual QC check');
    } catch { problems.push('QC report is invalid'); }
    const qualityFiles = fs.existsSync(path.join(projectPath, '05_edit'))
      ? fs.readdirSync(path.join(projectPath, '05_edit')).filter((name) => /^quality_report_v\d+\.json$/i.test(name)).sort()
      : [];
    const qualityFile = qualityFiles.at(-1);
    if (!qualityFile) problems.push('Independent quality report is required');
    else {
      try {
        const quality = validateQualityReport(JSON.parse(fs.readFileSync(path.join(projectPath, '05_edit', qualityFile), 'utf8')));
        if (!quality.valid) problems.push(`Quality report is invalid: ${quality.problems.join('; ')}`);
      } catch { problems.push('Quality report is invalid'); }
    }
  }
  if (stageId === 'package') {
    const file = path.join(projectPath, filesystem.stages.package.files.at(-1) || '06_publish/metadata_v1.json');
    if (!filesystem.valid.package) problems.push('No valid versioned metadata file was recognized');
    try {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!String(metadata.title || '').trim() || !String(metadata.description || '').trim()) problems.push('Metadata needs a title and description');
      if (String(metadata.title || '').length > 100 || String(metadata.description || '').length > 5000) problems.push('Metadata exceeds YouTube character limits');
      if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) problems.push('Metadata tags must be an array');
      if (Array.isArray(metadata.tags) && metadata.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) problems.push('Metadata tags must be non-empty strings');
      if (Array.isArray(metadata.tags) && metadata.tags.join(',').length > 500) problems.push('Metadata tags exceed YouTube limits');
    } catch { problems.push('Metadata is invalid JSON'); }
    const subtitles = path.join(projectPath, '06_publish', 'subtitles');
    const hasSubtitles = fs.existsSync(subtitles) && walkFiles(subtitles).some((file) => /\.(srt|vtt)$/i.test(file));
    if (!hasSubtitles) problems.push('At least one timed subtitle file is required');
  }
  if (!FILESYSTEM_MANAGED_STAGES.has(stageId) && !stage.substages.every((substage) => {
    if (!requiredOutputs(stageId, substage).length) return true;
    return requiredOutputs(stageId, substage).every((relative) => fs.existsSync(path.join(projectPath, relative)));
  })) problems.push('One or more required stage steps have not produced output');
  return [...new Set(problems)];
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function runJsonCommand(command, args, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries([
      'PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
      'YOUTUBE_CLIENT_SECRET_PATH', 'YOUTUBE_TOKEN_PATH',
    ].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    environment.PYTHONUNBUFFERED = '1';
    const child = spawn(command, args, { cwd, shell: false, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(Object.assign(new Error('Command timed out'), { statusCode: 504 }));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-200_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-50_000); });
    child.on('error', (error) => { settled = true; clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const parsed = JSON.parse(lines.at(-1) || '{}');
        if (code !== 0 && !parsed.error) parsed.error = stderr.trim() || `Command exited with code ${code}`;
        resolve(parsed);
      } catch { reject(Object.assign(new Error(stderr.trim() || 'Command returned invalid JSON'), { statusCode: 502 })); }
    });
  });
}

function startAutomatedPublish(projectKey, { privacy = 'private' } = {}) {
  const project = store.getProject(projectKey);
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  if (store.listPublications(projectKey).some((publication) => publication.remoteId || publication.status === 'uploading')) {
    throw Object.assign(new Error('This workspace already has an upload in progress or completed'), { statusCode: 409 });
  }
  const projectPath = projectPathForKey(projectKey);
  const candidate = validatePrivateCandidate(projectKey, projectPath);
  const { manifest, metadata } = candidate;
  const video = path.join(projectPath, manifest.artifacts.video.path);
  const metadataFile = path.join(projectPath, manifest.artifacts.metadata.path);
  const thumbnail = path.join(projectPath, manifest.artifacts.thumbnail.path);
  const publicationId = crypto.randomUUID();
  const requestFile = path.join(projectPath, '06_publish', `publish_request_${publicationId}.json`);
  const resultFile = path.join(projectPath, '06_publish', `publication_result_${publicationId}.json`);
  const payload = { video, metadataFile, privacy: 'private', publishAt: null, thumbnail, resultFile, releaseManifest: manifest };
  writeAtomic(requestFile, JSON.stringify(payload, null, 2));
  const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
  if (!fs.existsSync(python)) throw Object.assign(new Error('YouTube environment is not installed'), { statusCode: 503 });
  const commandSpec = { command: python, args: [path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py'), 'upload', '--request', requestFile], cwd: path.join(PROJECT_ROOT, 'youtube-mcp') };
  const run = jobs.enqueue({ project, stageId: 'publish', substage: 'upload', adapter: 'youtube', commandSpec, projectPath,
    inputHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  store.createPublication({ id: publicationId, projectKey, runId: run.id, privacy: 'private', scheduledAt: null, payload });
  store.recordReleaseEvent({ projectKey, publicationId, actor: 'automation', action: 'private_candidate_queued', payload: { score: candidate.quality.score, manifest: '06_publish/release_manifest_v1.json', title: metadata.title } });
  publicationByRun.set(run.id, publicationId);
  return { run, publicationId };
}

function readJsonFile(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw Object.assign(new Error(`${label} is missing or invalid`), { statusCode: 422 }); }
}

function validatePrivateCandidate(projectKey, projectPath) {
  const manifestFile = path.join(projectPath, '06_publish', 'release_manifest_v1.json');
  const manifest = readJsonFile(manifestFile, 'Release manifest');
  const manifestProblems = verifyReleaseManifest(projectPath, manifest);
  if (manifestProblems.length) throw Object.assign(new Error(`Release manifest is stale: ${manifestProblems.join('; ')}`), { statusCode: 409 });
  const quality = validateQualityReport(readJsonFile(path.join(projectPath, manifest.qualityReport.path), 'Quality report'));
  if (!quality.valid) throw Object.assign(new Error(`Quality report is invalid: ${quality.problems.join('; ')}`), { statusCode: 422 });
  if (quality.score < PRIVATE_UPLOAD_THRESHOLD) throw Object.assign(new Error(`Private candidate requires a quality score of ${PRIVATE_UPLOAD_THRESHOLD}; current score is ${quality.score}`), { statusCode: 409 });
  if (quality.unresolvedBlockers.length) throw Object.assign(new Error(`Private candidate has ${quality.unresolvedBlockers.length} unresolved blocker(s)`), { statusCode: 409 });
  const voiceProfile = readJsonFile(path.join(projectPath, manifest.artifacts.voiceProfile.path), 'Voice profile');
  const recordedConsent = String(voiceProfile.consentRecord || '').trim()
    || (['bundled_authorized_reference', 'studio_recording'].includes(String(voiceProfile.source || '')) ? String(voiceProfile.source) : '');
  if (voiceProfile.consentRequired && !recordedConsent) {
    throw Object.assign(new Error('Voice profile requires a recorded consent receipt before upload'), { statusCode: 409 });
  }
  const metadata = readJsonFile(path.join(projectPath, manifest.artifacts.metadata.path), 'Metadata');
  if (!String(metadata.title || '').trim() || !String(metadata.description || '').trim()) throw Object.assign(new Error('Release metadata requires title and description'), { statusCode: 422 });
  return { manifest, quality, metadata };
}

function writeReleaseContract(projectKey, projectPath, selection, session) {
  const evidenceIndexPath = String(selection.evidenceIndexPath || '01_research/evidence_index_v1.json');
  const qualityReportPath = String(selection.qualityReportPath || '05_edit/quality_report_v1.json');
  const manifest = buildReleaseManifest({ root: projectPath, projectKey, selection, qualityReportPath, evidenceIndexPath, owner: session?.id || 'owner' });
  const relativePath = '06_publish/release_manifest_v1.json';
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  writeAtomic(path.join(projectPath, relativePath), content);
  store.recordArtifact({ projectKey, stageId: 'publish', relativePath, content, mimeType: 'application/json; charset=utf-8', provenance: { action: 'release_contract', actor: session?.id || 'owner' }, status: 'approved' });
  store.recordReleaseEvent({ projectKey, actor: session?.id || 'owner', action: 'release_manifest_created', payload: { relativePath } });
  return manifest;
}

function selectAutomatedScript(projectKey) {
  try { return Boolean(approveCurrentScripts(projectKey).canonical); }
  catch { return false; }
}

researchPipeline = new ResearchPipelineController({
  store,
  getProject: (projectKey) => store.getProject(projectKey),
  projectPathForKey,
  queueStage: (input) => queueStageRun(input),
  cancelRuns: (projectKey) => jobs.cancelForProject(projectKey, 'research'),
  emit: broadcast,
});

automation = new AutomationController({
  store, stages: STAGES, getProject: (projectKey) => store.getProject(projectKey),
  queueStage: ({ projectKey, stageId, substage, topic, proactive }) => queueStageRun({ projectKey, stageId, substage,
    planningMode: stageId === 'idea' ? (proactive ? 'proactive' : 'guided') : undefined,
    topicDescription: stageId === 'idea' ? (topic || '') : undefined,
    adapter: autopilotAdapter(store.getProject(projectKey), stageId),
  }),
  startResearch: ({ projectKey, direction }) => researchPipeline.start({
    projectKey,
    direction,
    adapter: autopilotAdapter(store.getProject(projectKey), 'research'),
  }),
  validateStage: validateStageForApproval,
  approveStage: (projectKey, stageId, note) => store.approve({ projectKey, stageId, decision: 'approved', note }),
  selectIdea: autoSelectIdea,
  selectScript: selectAutomatedScript,
  startPublish: startAutomatedPublish,
  emit: broadcast,
});

// Reattach durable detached commands only after both orchestrators exist, so a
// recovered research task can continue its fan-out/fan-in state machine.
jobs.recoverActiveRuns();

function createWorkspace(channelId, settingsPatch = {}) {
  channelId = assertId(channelId, 'channel');
  readChannel(channelId);
  const { slug, title, projectPath } = createDatedWorkspace(channelId);
  const settings = validateSettings({ targetDurationMin: 12, language: 'hi', wordsPerMinute: 130, researchMaxAngles: 10, researchMaxSynthesisPasses: 3, scriptQualityThreshold: DEFAULT_SCRIPT_QUALITY_THRESHOLD, scriptMaxAutoRevisions: DEFAULT_SCRIPT_MAX_AUTO_REVISIONS, autopilot: false, ...settingsPatch });
  ensureStructure(projectPath);
  writeAtomic(path.join(projectPath, 'README.md'), `# ${title}\n\n**Channel:** ${channelId}\n**Created:** ${new Date().toISOString()}\n`);
  const projectKey = `${channelId}__${slug}`;
  writeAtomic(path.join(projectPath, '00_project', 'project_brief.md'), '# Project brief\n\nThis dated workspace is ready for planning. Choose either proactive discovery or add a topic from the Idea stage.\n');
  const project = store.ensureProject({ projectKey, channelId, slug, title, settings });
  ensureDefaultAudioProfiles(projectPath, projectKey);
  store.patchStage(projectKey, 'idea', { data: { planningMode: 'proactive' } });
  return store.getProject(project.projectKey);
}

function startManualAutomationIfEligible(projectKey, origin = 'gui') {
  if (automation?.activeFor(projectKey)) return null;
  const project = store.getProject(projectKey);
  const stage = STAGES.find((item) => item.id !== 'publish' && project?.stages?.[item.id]?.autoMode
    && project.stages[item.id].status === 'ready' && item.requires.every((required) => project.stages[required]?.status === 'approved'));
  return stage ? automation.start({ projectKey, mode: 'manual', origin, startStage: stage.id }) : null;
}

function isLoopbackRequest(request) {
  const address = String(request.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function requireAgentLoopback(request) {
  if (!isLoopbackRequest(request) || !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    throw Object.assign(new Error('The headless agent API is available only on a loopback Chitra Yantra server'), { statusCode: 403 });
  }
}

async function routeAgentApi(request, response, pathname, url) {
  requireAgentLoopback(request);
  const prefix = '/api/agent/v1';
  const relative = pathname.slice(prefix.length) || '/';
  if (request.method === 'GET' && relative === '/') {
    return sendJson(response, 200, { version: 'v1', stages: STAGES, capabilities: ['workspaces', 'automation', 'adaptive-research', 'runs', 'artifacts', 'events'] });
  }
  if (request.method === 'GET' && relative === '/channels') return sendJson(response, 200, { channels: scanChannels() });
  if (request.method === 'POST' && relative === '/workspaces') {
    const body = await readBody(request);
    const project = createWorkspace(body.channelId, body.settings || {});
    let workflow = null;
    if (body.start || body.topic || body.proactive) workflow = automation.start({ projectKey: project.projectKey, mode: body.mode === 'manual' ? 'manual' : 'global', origin: 'api', topic: body.topic, proactive: Boolean(body.proactive), startStage: body.startStage || null });
    return sendJson(response, 201, { project: store.getProject(project.projectKey), workflow });
  }
  let match = relative.match(/^\/workspaces\/([^/]+)$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const synced = syncFilesystemState(projectKey);
    return sendJson(response, 200, { project: synced.project, filesystem: synced.filesystem, artifacts: visibleArtifacts(projectKey), runs: store.listRuns(projectKey), workflow: store.latestWorkflow(projectKey), publications: store.listPublications(projectKey) });
  }
  match = relative.match(/^\/workspaces\/([^/]+)\/events$/);
  if (match && request.method === 'GET') return sendJson(response, 200, { events: store.listWorkflowEvents(assertProjectKey(match[1]), url.searchParams.get('after'), url.searchParams.get('limit')) });
  match = relative.match(/^\/workspaces\/([^/]+)\/artifacts$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const stageId = url.searchParams.get('stage');
    if (stageId && !STAGE_IDS.has(stageId)) throw Object.assign(new Error('Invalid stage'), { statusCode: 400 });
    return sendJson(response, 200, { artifacts: syncArtifacts(projectKey, stageId) });
  }
  match = relative.match(/^\/workspaces\/([^/]+)\/research$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return sendJson(response, 200, { profile: existingVoiceProfile(projectPathForKey(projectKey), project) });
  }
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const body = await readBody(request);
    const started = researchPipeline.start({
      projectKey,
      adapter: body.adapter || autopilotAdapter(store.getProject(projectKey), 'research'),
      direction: body.direction || '',
    });
    return sendJson(response, 202, started);
  }
  match = relative.match(/^\/workspaces\/([^/]+)\/automation$/);
  if (match && request.method === 'POST') {
    const body = await readBody(request);
    const workflow = automation.start({ projectKey: assertProjectKey(match[1]), mode: body.mode === 'manual' ? 'manual' : 'global', origin: 'api', topic: body.topic, proactive: Boolean(body.proactive), startStage: body.startStage || null });
    return sendJson(response, 202, { workflow, project: store.getProject(workflow.projectKey) });
  }
  match = relative.match(/^\/workspaces\/([^/]+)\/automation\/([a-f0-9-]+)\/(resume|pause|cancel)$/);
  if (match && request.method === 'POST') {
    const [, key, workflowId, action] = match;
    const projectKey = assertProjectKey(key);
    const body = await readBody(request);
    const workflow = action === 'resume' ? automation.resume(projectKey, workflowId, 'api')
      : action === 'pause' ? automation.pause(projectKey, workflowId, String(body.reason || 'Paused by agent'), 'api')
        : automation.cancel(projectKey, workflowId, 'api');
    if (!workflow) throw Object.assign(new Error('Workflow not found'), { statusCode: 404 });
    if (action === 'cancel') jobs.cancelForProject(projectKey);
    return sendJson(response, 200, { workflow });
  }
  match = relative.match(/^\/workspaces\/([^/]+)\/stages\/([^/]+)\/run$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const stageId = assertId(match[2], 'stage');
    const body = await readBody(request);
    if (!STAGE_IDS.has(stageId) || stageId === 'publish') throw Object.assign(new Error('Invalid runnable stage'), { statusCode: 400 });
    const run = queueStageRun({ projectKey, stageId, substage: body.substage, adapter: body.adapter, planningMode: body.planningMode, topicDescription: body.topic, iterationNote: body.iterationNote, parentArtifact: body.parentArtifact, language: body.language });
    return sendJson(response, 202, { run });
  }
  match = relative.match(/^\/runs\/([a-f0-9-]+)$/);
  if (match && request.method === 'GET') {
    const run = store.getRun(match[1]);
    if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    return sendJson(response, 200, { run });
  }
  if (match && request.method === 'DELETE') {
    if (!jobs.cancel(match[1])) throw Object.assign(new Error('Active run not found'), { statusCode: 404 });
    return sendJson(response, 202, { cancelled: true });
  }
  match = relative.match(/^\/runs\/([a-f0-9-]+)\/log$/);
  if (match && request.method === 'GET') {
    const run = store.getRun(match[1]);
    if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    let content = '';
    try { content = fs.readFileSync(run.logPath, 'utf8').slice(-250_000); } catch { /* no output yet */ }
    return sendJson(response, 200, { run, content });
  }
  throw Object.assign(new Error('Agent API route not found'), { statusCode: 404 });
}

async function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : assertRelativePath(pathname.slice(1));
  const file = resolveContained(PUBLIC_DIR, relative, { mustExist: true });
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  securityHeaders(response);
  // Assets are not content-hashed; caching them can mix incompatible HTML/JS after an update.
  response.setHeader('Cache-Control', 'no-store');
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
}

function serveMedia(request, response, file) {
  const stat = fs.statSync(file);
  const contentType = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.range;
  securityHeaders(response);
  response.setHeader('Content-Type', contentType);
  response.setHeader('Accept-Ranges', 'bytes');
  if (!range) {
    response.writeHead(200, { 'Content-Length': stat.size });
    return fs.createReadStream(file).pipe(response);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return sendJson(response, 416, { error: 'Invalid range' });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) return sendJson(response, 416, { error: 'Range not satisfiable' });
  response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(response);
}

async function route(request, response) {
  response.requestId = crypto.randomUUID();
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw Object.assign(new Error('Malformed URL encoding'), { statusCode: 400 }); }

  if (request.method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { status: 'ok', version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) });
  }

  if (request.method === 'GET' && pathname === '/api/session') {
    if (!requestOriginAllowed(request)) throw Object.assign(new Error('Origin not allowed'), { statusCode: 403 });
    const old = getSession(request);
    const id = old?.id || randomToken();
    const session = old || { id, csrf: randomToken(), expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(id, session);
    return sendJson(response, 200, { csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }, {
      'Set-Cookie': `chitra_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  }

  if (pathname === '/api/agent/v1' || pathname.startsWith('/api/agent/v1/')) {
    return routeAgentApi(request, response, pathname, url);
  }

  if (pathname.startsWith('/api/')) requireSession(request, { mutation: !['GET', 'HEAD'].includes(request.method) });

  if (request.method === 'GET' && pathname === '/api/config') {
    return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, stages: STAGES, agents: Object.entries(AGENTS).map(([id, value]) => ({ id, name: value.label, stages: value.stages })) });
  }
  if (request.method === 'GET' && pathname === '/api/channels') return sendJson(response, 200, { channels: scanChannels() });

  if (request.method === 'POST' && pathname === '/api/projects') {
    const body = await readBody(request);
    return sendJson(response, 201, { project: createWorkspace(body.channelId) });
  }

  let match = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match) {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    if (request.method === 'GET') {
      projectPathForKey(projectKey);
      const synced = syncFilesystemState(projectKey);
      return sendJson(response, 200, { project: synced.project, filesystem: synced.filesystem, artifacts: visibleArtifacts(projectKey), runs: store.listRuns(projectKey), publications: store.listPublications(projectKey) });
    }
    if (request.method === 'PATCH') {
      projectPathForKey(projectKey);
      const body = await readBody(request);
      if (body.currentStage && !STAGE_IDS.has(body.currentStage)) throw Object.assign(new Error('Invalid current stage'), { statusCode: 400 });
      if (body.title !== undefined && !String(body.title).trim()) throw Object.assign(new Error('Video title is required'), { statusCode: 400 });
      const targetChannelId = body.channelId === undefined ? project.channelId : assertId(body.channelId, 'channel');
      if (targetChannelId !== project.channelId) readChannel(targetChannelId);
      const moved = targetChannelId === project.channelId ? project : moveProjectToChannel(projectKey, targetChannelId);
      const updated = store.updateProject(moved.projectKey, { title: body.title, currentStage: body.currentStage, settings: body.settings === undefined ? undefined : validateSettings(body.settings) });
      if (body.settings?.autopilot === false) {
        const workflow = automation?.activeFor(updated.projectKey);
        if (workflow) automation.cancel(updated.projectKey, workflow.id, 'gui');
      }
      if (body.title !== undefined || targetChannelId !== project.channelId) {
        const file = path.join(projectPathForKey(updated.projectKey), 'README.md');
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const titled = body.title !== undefined
          ? (existing.match(/^#\s+/) ? existing.replace(/^#\s+.+$/m, `# ${updated.title}`) : `# ${updated.title}\n\n${existing}`)
          : existing;
        writeAtomic(file, titled.match(/^\*\*Channel:\*\*/m) ? titled.replace(/^\*\*Channel:\*\*.*$/m, `**Channel:** ${updated.channelId}`) : `${titled}\n**Channel:** ${updated.channelId}\n`);
      }
      return sendJson(response, 200, { project: updated });
    }
    if (request.method === 'DELETE') {
      jobs.cancelForProject(projectKey);
      const { channelId, slug } = parseProjectKey(projectKey);
      const channelRoot = resolveContained(CHANNELS_DIR, channelId, { mustExist: true });
      const videosRoot = resolveContained(channelRoot, 'videos', { mustExist: true });
      const projectPath = resolveContained(videosRoot, slug, { mustExist: false });

      // Defensive scoping check: verify path is strictly a direct child of videosRoot
      const resolvedProject = path.resolve(projectPath);
      const resolvedVideos = path.resolve(videosRoot);
      if (path.dirname(resolvedProject) !== resolvedVideos || resolvedProject === resolvedVideos) {
        throw Object.assign(new Error('Unsafe workspace path scoping'), { statusCode: 400 });
      }

      if (fs.existsSync(projectPath)) {
        fs.rmSync(projectPath, { recursive: true, force: true });
      }
      store.deleteProject(projectKey);
      broadcast('project_deleted', { projectKey });
      return sendJson(response, 200, { ok: true, projectKey });
    }
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/idea\/select$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const idea = body.idea;
    if (!idea || typeof idea !== 'object') throw Object.assign(new Error('Idea payload is required'), { statusCode: 400 });
    const title = String(idea.title || '').trim().slice(0, 200);
    const version = String(body.version || 'v1');
    const index = Number(idea.index || body.ideaIndex || 1);

    const ideaData = {
      ...(project.stages?.idea?.data || {}),
      selectedIdea: {
        index,
        version,
        title,
        pitch: String(idea.pitch || ''),
        angle: String(idea.angle || ''),
        ratings: idea.ratings || {},
        whyNow: String(idea.whyNow || ''),
        visuals: String(idea.visuals || ''),
      },
      selectedConcept: String(idea.pitch || idea.raw || title),
      selectedTitle: title,
    };
    store.patchStage(projectKey, 'idea', { data: ideaData });

    const projectPath = projectPathForKey(projectKey);
    const briefPath = path.join(projectPath, '00_project', 'project_brief.md');
    let briefContent = `# Project Brief: ${title || 'Selected Concept'}\n\n`;
    briefContent += `**Selected Concept:** Idea ${index} (${version})\n\n`;
    if (idea.pitch) briefContent += `## Premise & Dramatic Conflict\n${idea.pitch}\n\n`;
    if (idea.angle) briefContent += `## Narrative Angle & Tension\n${idea.angle}\n\n`;
    if (idea.whyNow) briefContent += `## Contemporary Relevance (Why Now)\n${idea.whyNow}\n\n`;
    if (idea.visuals) briefContent += `## Visual Storytelling Plan\n${idea.visuals}\n\n`;
    if (idea.ratings && Object.keys(idea.ratings).length) {
      briefContent += `## Ratings\n- Tension: ${idea.ratings.tension || '—'}/5\n- Evidence: ${idea.ratings.evidence || '—'}/5\n- Visuals: ${idea.ratings.visual || '—'}/5\n\n`;
    }
    writeAtomic(briefPath, briefContent);
    store.recordArtifact({
      projectKey,
      stageId: 'idea',
      relativePath: '00_project/project_brief.md',
      content: briefContent,
      mimeType: 'text/markdown; charset=utf-8',
      provenance: { source: 'idea_selection', version, index },
    });

    let updatedProject = store.getProject(projectKey);
    if (body.updateTitle || (title && (updatedProject.title.startsWith('Untitled video') || updatedProject.title === project.slug))) {
      updatedProject = store.updateProject(projectKey, { title });
      const readmePath = path.join(projectPath, 'README.md');
      if (fs.existsSync(readmePath)) {
        const existing = fs.readFileSync(readmePath, 'utf8');
        const titled = existing.match(/^#\s+/)
          ? existing.replace(/^#\s+.+$/m, `# ${updatedProject.title}`)
          : `# ${updatedProject.title}\n\n${existing}`;
        writeAtomic(readmePath, titled);
      }
    }

    broadcast('project_updated', { projectKey: updatedProject.projectKey, project: updatedProject });
    return sendJson(response, 200, { ok: true, project: updatedProject, artifacts: store.listArtifacts(projectKey, 'idea') });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/research\/discard$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const { claimId, claimText, reason } = body;
    if (!claimText) throw Object.assign(new Error('claimText is required'), { statusCode: 400 });
    const projectPath = projectPathForKey(projectKey);
    const discardPath = path.join(projectPath, '01_research', 'material_discarded.md');
    let existingContent = fs.existsSync(discardPath)
      ? fs.readFileSync(discardPath, 'utf8')
      : '# Discarded Research Material & Rejected Claims\n\nThis file documents dubious assertions, unverified myths, or editorial rejections.\nItems listed here are **strictly excluded** from script outline and narration generation.\n\n## Discarded Claims\n\n';
    existingContent += `- **${claimId || 'Claim'}**: ${claimText} *(Reason: ${reason || 'Excluded by researcher'})*\n`;
    writeAtomic(discardPath, existingContent);
    store.recordArtifact({
      projectKey,
      stageId: 'research',
      relativePath: '01_research/material_discarded.md',
      content: existingContent,
      mimeType: 'text/markdown; charset=utf-8',
    });

    const ledgerPath = path.join(projectPath, '01_research', 'claim_ledger.json');
    if (fs.existsSync(ledgerPath)) {
      try {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        const found = (ledger.claims || []).find((c) => c.id === claimId || c.claim === claimText);
        if (found) {
          found.status = 'DISCARDED';
          found.discardReason = reason || 'Excluded by researcher';
          const ledgerContent = JSON.stringify(ledger, null, 2);
          writeAtomic(ledgerPath, ledgerContent);
          store.recordArtifact({
            projectKey,
            stageId: 'research',
            relativePath: '01_research/claim_ledger.json',
            content: ledgerContent,
            mimeType: 'application/json; charset=utf-8',
            provenance: { editedIn: 'discard_claim', claimId: claimId || null },
          });
        }
      } catch {}
    }
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { ok: true, artifacts: store.listArtifacts(projectKey, 'research') });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/research\/pipeline$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const body = await readBody(request);
    const started = researchPipeline.start({
      projectKey,
      adapter: body.adapter || autopilotAdapter(store.getProject(projectKey), 'research'),
      direction: body.direction || body.manualSources || '',
    });
    return sendJson(response, 202, started);
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    syncArtifacts(projectKey, 'script');
    return sendJson(response, 200, {
      versions: visibleScriptVersions(projectKey),
      comments: store.listScriptComments(projectKey),
      artifacts: visibleArtifacts(projectKey, 'script'),
    });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/versions\/([a-f0-9-]+)\/comments$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const version = store.getScriptVersion(projectKey, match[2]);
    if (!version) throw Object.assign(new Error('Script version not found'), { statusCode: 404 });
    const body = await readBody(request);
    const scope = ['text', 'section', 'global'].includes(body.scope) ? body.scope : 'text';
    const commentBody = String(body.body || '').trim();
    if (!commentBody) throw Object.assign(new Error('Comment cannot be empty'), { statusCode: 400 });
    const comment = store.addScriptComment({ projectKey, scriptVersionId: version.id, scope, sectionLabel: body.sectionLabel || '', quoteText: body.quoteText || '', body: commentBody });
    return sendJson(response, 201, { comment });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/comments\/([a-f0-9-]+)\/resolve$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const comment = store.resolveScriptComment(projectKey, match[2]);
    if (!comment) throw Object.assign(new Error('Comment not found'), { statusCode: 404 });
    return sendJson(response, 200, { comment });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/versions\/([a-f0-9-]+)\/select$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const version = store.getScriptVersion(projectKey, match[2]);
    if (!version) throw Object.assign(new Error('Script version not found'), { statusCode: 404 });
    const coverage = factcheckCoverageForScriptVersion(projectKey, version);
    if (!coverage.covered) throw Object.assign(new Error(coverage.reason || 'Run and clear fact-check before selecting this script'), { statusCode: 409 });
    const body = await readBody(request);
    const inheritedNote = coverage.inherited ? ` Fact-check inherited from ${coverage.from}; source metadata was preserved in this adaptive branch.` : '';
    const selected = store.selectMasterScript(projectKey, version.id, `${body.note || 'Selected in Script Studio'}${inheritedNote}`);
    store.patchStage(projectKey, 'script', { data: { selectedScriptVersionId: selected.id, selectedScriptPath: selected.relativePath } });
    return sendJson(response, 200, { version: selected, project: store.getProject(projectKey) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/versions\/([a-f0-9-]+)\/revise$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const version = store.getScriptVersion(projectKey, match[2]);
    if (!version) throw Object.assign(new Error('Script version not found'), { statusCode: 404 });
    const body = await readBody(request);
    const comments = store.listScriptComments(projectKey, version.id).filter((comment) => comment.status === 'open');
    const direction = String(body.direction || '').trim();
    if (!direction && !comments.length) throw Object.assign(new Error('Add a direction or an open comment before revising'), { statusCode: 400 });
    const feedback = comments.map((comment) => `[${comment.scope}] ${comment.quoteText ? `“${comment.quoteText}” — ` : ''}${comment.body}`).join('\n');
    const run = queueStageRun({ projectKey, stageId: 'script', substage: 'draft', adapter: body.adapter, parentArtifact: version.relativePath, language: version.language,
      iterationNote: `Create a new revision; never overwrite the parent. Global direction: ${direction || 'Apply the attached review notes.'}\nReview notes:\n${feedback}` });
    return sendJson(response, 202, { run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/versions\/([a-f0-9-]+)\/quality$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const version = store.getScriptVersion(projectKey, match[2]);
    if (!version) throw Object.assign(new Error('Script version not found'), { statusCode: 404 });
    const body = await readBody(request);
    const focus = body.focus === 'analysis' ? 'YouTube narration analysis' : 'fact-check';
    const run = queueStageRun({ projectKey, stageId: 'script', substage: 'review', adapter: body.adapter, parentArtifact: version.relativePath, language: version.language,
      iterationNote: `Perform a critical ${focus} and revise the complete script directly. This is a new content revision, not a separate report.` });
    return sendJson(response, 202, { run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/versions\/([a-f0-9-]+)\/translate$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const version = store.getScriptVersion(projectKey, match[2]);
    if (!version) throw Object.assign(new Error('Choose a script before translating'), { statusCode: 409 });
    const body = await readBody(request);
    const language = String(body.language || '').trim();
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw Object.assign(new Error('Use a BCP 47 language code such as en or hi'), { statusCode: 400 });
    const run = queueStageRun({ projectKey, stageId: 'script', substage: 'draft', adapter: body.adapter, parentArtifact: version.relativePath, language,
      iterationNote: `Adaptive translation from this source branch. Preserve sentence-level meaning, narrative tone, pacing, and all visual cue markers. Do not translate literally. This is a translation for alternate audio, not a new research pass.` });
    return sendJson(response, 202, { run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/versions\/([a-f0-9-]+)\/finalize$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const version = store.getScriptVersion(projectKey, match[2]);
    if (!version) throw Object.assign(new Error('Script version not found'), { statusCode: 404 });
    const approved = approveCurrentScripts(projectKey, version.id);
    return sendJson(response, 200, { version: approved.canonical, project: approved.project, versions: approved.versions });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-studio\/approve$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const body = await readBody(request);
    const approved = approveCurrentScripts(projectKey, String(body.selectedVersionId || ''));
    return sendJson(response, 200, approved);
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/script-pipeline$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    if (['queued', 'running'].includes(project.stages.script?.status)) {
      throw Object.assign(new Error('The script pipeline is already running'), { statusCode: 409 });
    }
    const body = await readBody(request);
    const authoringLanguage = scriptAuthoringLanguage(project);
    const hindiLanguage = languageName(project.settings?.language || 'hi');
    const englishTarget = iterationTarget(projectPathForKey(projectKey), 'script', authoringLanguage, 'draft').target;
    const hindiTarget = iterationTarget(projectPathForKey(projectKey), 'script', hindiLanguage, 'draft').target;
    const firstSubstage = 'author';
    store.patchStage(projectKey, 'script', {
      autoMode: true,
      data: { ...(project.stages.script?.data || {}), autoRepairAttempts: 0, scriptAutoPipelineStartedAt: new Date().toISOString(), scriptAutoPipelineStart: firstSubstage, scriptAuthoringLanguage: authoringLanguage },
    });
    const run = queueStageRun({ projectKey, stageId: 'script', substage: firstSubstage, adapter: body.adapter, language: authoringLanguage, outputTarget: englishTarget, outputTargets: [englishTarget, hindiTarget] });
    return sendJson(response, 202, { project: store.getProject(projectKey), run, firstSubstage });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/editorial-blueprint$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const requested = url.searchParams.get('version');
    const requestedVersion = requested === null ? null : Number(requested);
    if (requested !== null && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
      throw Object.assign(new Error('Blueprint version must be a positive integer'), { statusCode: 400 });
    }
    const projectPath = projectPathForKey(projectKey);
    const loaded = readEditorialBlueprint(projectPath, project, requestedVersion);
    if (requestedVersion !== null && !loaded.relativePath) throw Object.assign(new Error(`Blueprint v${requestedVersion} was not found`), { statusCode: 404 });
    if (!loaded.blueprint) return sendJson(response, 200, { blueprint: null, summary: null, problems: [], legacy: false, relativePath: null });
    return sendJson(response, 200, {
      blueprint: loaded.blueprint, relativePath: loaded.relativePath, legacy: loaded.legacy,
      versions: blueprintFiles(projectPath).map((file) => ({ version: planVersion(file), relativePath: `04_visuals/plans/${file}` })),
      summary: blueprintSummary(loaded.blueprint), problems: validateBlueprint(loaded.blueprint),
    });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/editorial-blueprint\/beats\/([^/]+)$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const beatId = String(match[2] || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(beatId)) throw Object.assign(new Error('Invalid beat'), { statusCode: 400 });
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw Object.assign(new Error('A beat patch object is required'), { statusCode: 400 });
    const projectPath = projectPathForKey(projectKey);
    const loaded = readEditorialBlueprint(projectPath, project);
    if (!loaded.blueprint) throw Object.assign(new Error('Generate an Editorial Blueprint before editing beats'), { statusCode: 404 });
    const blueprint = normaliseBlueprint(loaded.blueprint);
    const beat = blueprint.beats.find((item) => item.id === beatId);
    if (!beat) throw Object.assign(new Error(`Beat ${beatId} was not found`), { statusCode: 404 });
    const patch = body.patch;
    Object.assign(beat, ...['status'].filter((key) => patch[key] !== undefined).map((key) => ({ [key]: String(patch[key]).slice(0, 40) })));
    for (const key of ['narration', 'timing', 'visual', 'text', 'audio', 'source']) {
      if (patch[key] !== undefined) {
        if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) throw Object.assign(new Error(`${key} must be an object`), { statusCode: 400 });
        beat[key] = { ...beat[key], ...patch[key] };
        if (key === 'visual' && patch.visual.motion) beat.visual.motion = { ...beat.visual.motion, ...patch.visual.motion };
      }
    }
    const saved = writeBlueprintRevision({ projectKey, projectPath, project, blueprint, provenance: { editedIn: 'editorial_blueprint', beatId } });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { ...saved, summary: blueprintSummary(saved.blueprint), problems: validateBlueprint(saved.blueprint) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/editorial-blueprint\/assets\/([^/]+)$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const assetId = String(match[2] || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(assetId)) throw Object.assign(new Error('Invalid asset'), { statusCode: 400 });
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw Object.assign(new Error('An asset patch object is required'), { statusCode: 400 });
    const projectPath = projectPathForKey(projectKey);
    const loaded = readEditorialBlueprint(projectPath, project);
    if (!loaded.blueprint) throw Object.assign(new Error('Generate an Editorial Blueprint before editing assets'), { statusCode: 404 });
    const blueprint = normaliseBlueprint(loaded.blueprint);
    const asset = blueprint.assets.find((item) => item.id === assetId);
    if (!asset) throw Object.assign(new Error(`Asset ${assetId} was not found`), { statusCode: 404 });
    const patch = body.patch;
    for (const key of ['description', 'prompt', 'sourceKind', 'sourceUrl', 'license', 'attribution', 'sourceSuggestion']) {
      if (patch[key] !== undefined) asset[key] = String(patch[key]).slice(0, 12000);
    }
    if (patch.production !== undefined) {
      if (!patch.production || typeof patch.production !== 'object' || Array.isArray(patch.production)) throw Object.assign(new Error('production must be an object'), { statusCode: 400 });
      asset.production = { ...asset.production, ...patch.production };
    }
    const saved = writeBlueprintRevision({ projectKey, projectPath, project, blueprint, provenance: { editedIn: 'editorial_blueprint', assetId } });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { ...saved, summary: blueprintSummary(saved.blueprint), problems: validateBlueprint(saved.blueprint) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/editorial-blueprint\/reconcile-timing$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const projectPath = projectPathForKey(projectKey);
    const loaded = readEditorialBlueprint(projectPath, project);
    if (!loaded.blueprint) throw Object.assign(new Error('Generate an Editorial Blueprint before reconciling timing'), { statusCode: 404 });
    const blueprint = normaliseBlueprint(loaded.blueprint);
    const planned = Math.max(1, Number(blueprint.timing.targetDurationSeconds || 0), ...blueprint.beats.map((beat) => Number(beat.timing.endSeconds || 0)));
    const actual = Number(body.durationSeconds);
    if (!Number.isFinite(actual) || actual < 15 || actual > 14_400) throw Object.assign(new Error('Provide a final narration duration between 15 seconds and 4 hours'), { statusCode: 400 });
    const scale = actual / planned;
    for (const beat of blueprint.beats) {
      beat.timing.startSeconds = Number((Number(beat.timing.startSeconds || 0) * scale).toFixed(3));
      beat.timing.endSeconds = Number((Number(beat.timing.endSeconds || 0) * scale).toFixed(3));
      beat.timing.basis = 'voice_reconciled';
      if (beat.status === 'approved') beat.status = 'needs_review';
    }
    blueprint.timing = { ...blueprint.timing, basis: 'voice_reconciled', targetDurationSeconds: actual, reconciledAt: new Date().toISOString() };
    const saved = writeBlueprintRevision({ projectKey, projectPath, project, blueprint, provenance: { editedIn: 'editorial_blueprint', action: 'timing_reconciliation', durationSeconds: actual } });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { ...saved, summary: blueprintSummary(saved.blueprint), problems: validateBlueprint(saved.blueprint) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/editorial-blueprint\/compile-screen-states$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const loaded = readEditorialBlueprint(projectPath, project);
    if (!loaded.blueprint || loaded.legacy) throw Object.assign(new Error('Generate a versioned Editorial Blueprint before compiling screen states'), { statusCode: 409 });
    const compiled = compileScreenStates(loaded.blueprint);
    const saved = writeBlueprintRevision({ projectKey, projectPath, project, blueprint: compiled, provenance: { editedIn: 'screen_state_compiler', sourceBlueprint: loaded.relativePath } });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { ...saved, summary: blueprintSummary(saved.blueprint), problems: validateBlueprint(saved.blueprint) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/plan$/);
  if (match) {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const existing = latestAudioPlan(projectPath);
    if (request.method === 'GET') {
      if (!existing) return sendJson(response, 200, { plan: null, relativePath: null });
      const relativePath = `03_audio/plans/${existing}`;
      return sendJson(response, 200, { plan: JSON.parse(fs.readFileSync(path.join(projectPath, relativePath), 'utf8')), relativePath });
    }
    if (request.method === 'POST') {
      const loaded = readEditorialBlueprint(projectPath, project);
      if (!loaded.blueprint) throw Object.assign(new Error('Create an Editorial Blueprint before planning audio'), { statusCode: 409 });
      const nextVersion = Math.max(1, audioPlanVersion(existing) + 1);
      const profile = existingVoiceProfile(projectPath, project);
      const approvedScriptPaths = project.stages.script?.data?.approvedScriptPaths || {};
      const narrations = Object.entries(approvedScriptPaths).map(([language, scriptPath]) => ({ language, scriptPath }));
      const plan = makeAudioPlan({ blueprint: loaded.blueprint, title: project.title, version: nextVersion, voiceProfile: project.settings?.audioVoiceProfile || profile?.id || 'default-clone', narrations });
      const relativePath = `03_audio/plans/audio_plan_v${nextVersion}.json`;
      const content = `${JSON.stringify(plan, null, 2)}\n`;
      writeAtomic(path.join(projectPath, relativePath), content);
      store.recordArtifact({ projectKey, stageId: 'audio', relativePath, content, mimeType: 'application/json; charset=utf-8', provenance: { derivedFrom: loaded.relativePath, action: 'audio_plan' } });
      store.patchStage(projectKey, 'audio', { status: 'needs_review', data: { audioPlan: relativePath } });
      broadcast('project_updated', { projectKey });
      return sendJson(response, 201, { plan, relativePath });
    }
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/voice-profile$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    ensureDefaultAudioProfiles(projectPath, projectKey);
    return sendJson(response, 200, { profile: existingVoiceProfile(projectPath, project), profiles: readAudioProfiles(projectPath) });
  }
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const profileId = String(request.headers['x-audio-profile'] || 'default-clone').trim();
    const filename = path.basename(String(request.headers['x-filename'] || 'reference.wav'));
    const extension = path.extname(filename).toLowerCase();
    let transcript = '';
    try { transcript = decodeURIComponent(String(request.headers['x-reference-transcript'] || '')).trim(); }
    catch { throw Object.assign(new Error('Reference transcript encoding is invalid'), { statusCode: 400 }); }
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(profileId)) throw Object.assign(new Error('Invalid voice profile name'), { statusCode: 400 });
    if (!['.wav', '.m4a', '.mp3', '.flac'].includes(extension)) throw Object.assign(new Error('Voice reference must be WAV, M4A, MP3, or FLAC'), { statusCode: 415 });
    if (!transcript) throw Object.assign(new Error('An exact reference transcript is required for voice cloning'), { statusCode: 400 });
    const buffer = await readBinaryBody(request);
    const projectPath = projectPathForKey(projectKey);
    const relativePath = `03_audio/references/${profileId}/reference${extension}`;
    const destination = resolveContained(projectPath, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer, { mode: 0o600 });
    const profileRelative = `03_audio/references/${profileId}/profile.json`;
    const transcriptPath = `03_audio/references/${profileId}/reference.txt`;
    writeAtomic(resolveContained(projectPath, transcriptPath), `${transcript}\n`);
    const profile = { schemaVersion: 1, id: profileId, referencePath: relativePath, transcriptPath, filename, transcript, updatedAt: new Date().toISOString(), consentRequired: true };
    writeAtomic(resolveContained(projectPath, profileRelative), `${JSON.stringify(profile, null, 2)}\n`);
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath, content: buffer, mimeType: MIME[extension] || 'application/octet-stream', provenance: { action: 'voice_profile_upload', profileId } });
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath: profileRelative, content: JSON.stringify(profile, null, 2), mimeType: 'application/json; charset=utf-8', provenance: { action: 'voice_profile_upload', profileId } });
    const updated = store.updateProject(projectKey, { settings: { audioVoiceProfile: profileId } });
    const configPath = path.join(projectPath, '03_audio', 'audio_pipeline.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.voice = { ...config.voice, reference_audio: destination, reference_text_file: resolveContained(projectPath, transcriptPath) };
      writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    broadcast('project_updated', { projectKey, project: updated });
    return sendJson(response, 201, { profile, project: updated });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/reference-candidates$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]); const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const root = path.join(projectPathForKey(projectKey), '03_audio', 'references');
    const candidates = fs.existsSync(root) ? walkFiles(root).filter((file) => file.endsWith('/candidate.json')).map((file) => {
      try {
        const candidate = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        const run = candidate.runId ? store.getRun(candidate.runId) : null;
        // A retry can complete outside the original queue record.  The output
        // file is authoritative: once it exists, present the take as ready and
        // allow it to be promoted even if an earlier attempt is still logged as
        // failed.
        const enhancedAvailable = fs.existsSync(resolveContained(projectPathForKey(projectKey), candidate.enhancedPath));
        return {
          ...candidate,
          enhancedAvailable,
          enhancementStatus: enhancedAvailable ? 'ready' : run?.status || candidate.status,
          enhancementError: enhancedAvailable ? null : run?.error || null,
        };
      } catch { return null; }
    }).filter(Boolean).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))) : [];
    return sendJson(response, 200, { candidates });
  }
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const language = languageName(String(request.headers['x-audio-language'] || 'hi'));
    if (!['hindi', 'english'].includes(language)) throw Object.assign(new Error('Reference language must be Hindi or English'), { statusCode: 400 });
    const filename = path.basename(String(request.headers['x-filename'] || 'reference.wav'));
    const extension = path.extname(filename).toLowerCase();
    if (!['.wav', '.m4a', '.mp3', '.webm'].includes(extension)) throw Object.assign(new Error('Reference must be WAV, MP3, M4A, or a browser recording'), { statusCode: 415 });
    let transcript = '';
    try { transcript = decodeURIComponent(String(request.headers['x-reference-transcript'] || '')).trim().slice(0, 4_000); }
    catch { throw Object.assign(new Error('Reference transcript encoding is invalid'), { statusCode: 400 }); }
    if (!transcript) throw Object.assign(new Error('Enter the words spoken in the reference recording'), { statusCode: 400 });
    const buffer = await readBinaryBody(request);
    const projectPath = projectPathForKey(projectKey);
    const candidateId = crypto.randomUUID();
    const base = `03_audio/references/${language}/candidates/${candidateId}`;
    const sourceRelative = `${base}/source${extension}`;
    const enhancedRelative = `${base}/enhanced.wav`;
    const metadataRelative = `${base}/candidate.json`;
    const source = resolveContained(projectPath, sourceRelative);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, buffer, { mode: 0o600 });
    const candidate = { id: candidateId, language, filename, transcript, sourcePath: sourceRelative, enhancedPath: enhancedRelative, status: 'queued', createdAt: new Date().toISOString() };
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath: sourceRelative, content: buffer, mimeType: MIME[extension] || 'application/octet-stream', provenance: { action: 'reference_candidate', candidateId, language } });
    const enhancementPython = fs.existsSync(path.join(PROJECT_ROOT, '.venv', 'bin', 'python')) ? path.join(PROJECT_ROOT, '.venv', 'bin', 'python') : 'python3';
    const run = jobs.enqueue({ project, stageId: 'audio', substage: `enhance-${candidateId.slice(0, 8)}`, adapter: 'python', projectPath, resource: 'audio-model',
      inputHash: crypto.createHash('sha256').update(buffer).digest('hex'),
      commandSpec: { command: enhancementPython, args: [path.join(PROJECT_ROOT, 'tools', 'enhance_reference.py'), source, resolveContained(projectPath, enhancedRelative)], cwd: PROJECT_ROOT, expectedOutputs: [enhancedRelative], timeoutMs: 10 * 60_000 } });
    candidate.runId = run.id;
    writeAtomic(resolveContained(projectPath, metadataRelative), `${JSON.stringify(candidate, null, 2)}\n`);
    return sendJson(response, 202, { candidate, run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/reference-candidates\/([a-f0-9-]+)\/promote$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]); const candidateId = match[2];
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request); const projectPath = projectPathForKey(projectKey);
    const candidates = walkFiles(path.join(projectPath, '03_audio', 'references')).filter((file) => file.endsWith(`/candidates/${candidateId}/candidate.json`));
    if (!candidates.length) throw Object.assign(new Error('Reference candidate not found'), { statusCode: 404 });
    const metadata = JSON.parse(fs.readFileSync(path.join(projectPath, '03_audio', 'references', candidates[0]), 'utf8'));
    const variant = body.variant === 'original' ? 'original' : 'enhanced';
    const sourceRelative = variant === 'enhanced' ? metadata.enhancedPath : metadata.sourcePath;
    const source = resolveContained(projectPath, sourceRelative, { mustExist: true });
    const id = `${metadata.language}-custom-${Date.now()}`;
    const destination = `03_audio/references/${id}`;
    const extension = path.extname(source).toLowerCase() || '.wav';
    const referencePath = `${destination}/reference${extension}`;
    const transcriptPath = `${destination}/reference.txt`;
    fs.mkdirSync(resolveContained(projectPath, destination), { recursive: true });
    fs.copyFileSync(source, resolveContained(projectPath, referencePath));
    writeAtomic(resolveContained(projectPath, transcriptPath), `${metadata.transcript}\n`);
    const profile = { schemaVersion: 2, id, language: metadata.language, label: `${metadata.language === 'hindi' ? 'Hindi' : 'English'} custom sample`, referencePath, transcriptPath, filename: metadata.filename, transcript: metadata.transcript, source: 'studio_recording', selectedVariant: variant, consentRequired: true, updatedAt: new Date().toISOString() };
    writeAtomic(profilePath(projectPath, id), `${JSON.stringify(profile, null, 2)}\n`);
    const updated = store.updateProject(projectKey, { settings: { audioVoiceProfile: id } });
    // Existing pipeline files are intentionally retained for tuning, but the
    // selected reference must change immediately for the next take.
    const configPath = path.join(projectPath, '03_audio', 'audio_pipeline.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.voice = { ...config.voice, reference_audio: path.join(projectPath, referencePath), reference_text_file: path.join(projectPath, transcriptPath) };
        writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
        store.recordArtifact({ projectKey, stageId: 'audio', relativePath: '03_audio/audio_pipeline.json', content: JSON.stringify(config, null, 2), mimeType: MIME['.json'], provenance: { action: 'select_voice_profile', profileId: id } });
      } catch { /* keep a malformed user-owned config visible for repair */ }
    }
    broadcast('project_updated', { projectKey, project: updated });
    return sendJson(response, 201, { profile, project: updated });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/comments$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const filename = latestAudioPlan(projectPath);
    if (!filename) throw Object.assign(new Error('Create an audio plan before adding a revision comment'), { statusCode: 409 });
    const relativePath = `03_audio/plans/${filename}`;
    const body = await readBody(request);
    const plan = JSON.parse(fs.readFileSync(path.join(projectPath, relativePath), 'utf8'));
    const revision = addCommentRevision(plan, body);
    const content = `${JSON.stringify(plan, null, 2)}\n`;
    writeAtomic(path.join(projectPath, relativePath), content);
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath, content, mimeType: 'application/json; charset=utf-8', provenance: { action: 'audio_comment', revisionId: revision.id } });
    const scope = ['voice', 'music', 'both'].includes(body.scope) ? body.scope : 'both';
    let run = null;
    try {
      // A note is actionable, not merely archival.  Voice is the first step for
      // "both" so the music model is never resident beside Higgs.
      run = queueStageRun({ projectKey, stageId: 'audio', substage: scope === 'music' ? 'music' : 'voice', adapter: 'python',
        iterationNote: `Audio revision ${revision.id}: ${revision.body}`, skipRequirementsCheck: true });
      store.patchStage(projectKey, 'audio', { status: 'queued', data: { audioPlan: relativePath, pendingAudioRevision: { ...revision, scope, runId: run.id } } });
    } catch (error) {
      store.patchStage(projectKey, 'audio', { status: 'needs_review', data: { audioPlan: relativePath, pendingAudioRevision: { ...revision, scope, queueError: error.message } } });
    }
    broadcast('project_updated', { projectKey });
    return sendJson(response, 201, { revision, relativePath, plan, run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/manifest$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const audioDir = path.join(projectPath, '03_audio');

    // 1. Audio Plan
    const planName = latestAudioPlan(projectPath);
    let plan = null;
    let planRelative = null;
    if (planName) {
      planRelative = `03_audio/plans/${planName}`;
      try { plan = JSON.parse(fs.readFileSync(path.join(projectPath, planRelative), 'utf8')); } catch {}
    }

    // 2. Audio Pipeline Config
    const configPath = path.join(audioDir, 'audio_pipeline.json');
    let pipelineConfig = null;
    if (fs.existsSync(configPath)) {
      try { pipelineConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    }

    const hasMusicCues = Boolean(plan && (
      (Array.isArray(plan.musicCues) && plan.musicCues.length > 0) ||
      (Array.isArray(plan.cues) && plan.cues.some((c) => c.type === 'music'))
    ));
    if (hasMusicCues && (!pipelineConfig?.music?.script || !pipelineConfig?.music?.manifest)) {
      try {
        ensureMusicPipelineConfig({ projectKey, project, projectPath });
        if (fs.existsSync(configPath)) {
          pipelineConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
      } catch {}
    }

    // 3. Voice Takes & Chunks
    const takesDir = path.join(audioDir, 'takes');
    const takeReports = [];
    const takeAudioFiles = [];
    if (fs.existsSync(takesDir)) {
      const takeEntries = fs.readdirSync(takesDir, { withFileTypes: true });
      for (const entry of takeEntries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(takesDir, entry.name), 'utf8'));
            takeReports.push({ filename: entry.name, data: parsed, mtime: fs.statSync(path.join(takesDir, entry.name)).mtimeMs });
          } catch {}
        } else if (entry.isFile() && /\.(wav|mp3|m4a|flac)$/i.test(entry.name)) {
          const fileStat = fs.statSync(path.join(takesDir, entry.name));
          takeAudioFiles.push({
            filename: entry.name,
            relativePath: `03_audio/takes/${entry.name}`,
            url: `/media/${encodeURIComponent(projectKey)}/03_audio/takes/${encodeURIComponent(entry.name)}`,
            size: fileStat.size,
            mtime: fileStat.mtimeMs,
          });
        }
      }
    }
    takeReports.sort((a, b) => b.mtime - a.mtime);
    takeAudioFiles.sort((a, b) => b.mtime - a.mtime);

    // A narration revision owns its take.  Falling back to mtime is retained
    // only for pre-review legacy workspaces, never for a reviewed manifest.
    const narrationReview = project.stages?.audio?.data?.narrationReview || null;
    const activeTakeReport = narrationReview?.activeTakeStem
      ? takeReports.find((report) => report.filename === `${narrationReview.activeTakeStem}.json`) || null
      : takeReports[0] || null;

    // Scan chunk folders
    const chunkDirs = fs.existsSync(takesDir)
      ? fs.readdirSync(takesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.endsWith('_chunks')).map((e) => e.name)
      : [];

    let primaryChunkDir = null;
    if (narrationReview?.activeTakeStem && chunkDirs.includes(`${narrationReview.activeTakeStem}_chunks`)) {
      primaryChunkDir = `${narrationReview.activeTakeStem}_chunks`;
    }
    if (!primaryChunkDir && activeTakeReport) {
      const stem = activeTakeReport.filename.replace(/\.json$/, '');
      if (chunkDirs.includes(`${stem}_chunks`)) {
        primaryChunkDir = `${stem}_chunks`;
      }
    }
    if (!primaryChunkDir && chunkDirs.length) {
      primaryChunkDir = chunkDirs.sort().at(-1);
    }

    const chunks = [];
    let chunksTotal = activeTakeReport?.data?.chunks_total || 0;
    let chunksComplete = activeTakeReport?.data?.chunks_complete || 0;
    const narrationPlans = fs.existsSync(path.join(audioDir, 'plans'))
      ? fs.readdirSync(path.join(audioDir, 'plans')).filter((name) => /^narration_.*\.json$/i.test(name)).sort()
      : [];
    let narrationManifest = null;
    if (narrationPlans.length) {
      try { narrationManifest = JSON.parse(fs.readFileSync(path.join(audioDir, 'plans', narrationPlans.at(-1)), 'utf8')); } catch {}
    }

    if (primaryChunkDir) {
      const fullChunkPath = path.join(takesDir, primaryChunkDir);
      const chunkFiles = fs.readdirSync(fullChunkPath);
      const wavFiles = chunkFiles.filter((f) => /^chunk_\d+\.wav$/i.test(f)).sort();
      const txtFiles = new Set(chunkFiles.filter((f) => /^chunk_\d+\.txt$/i.test(f)));
      const jsonFiles = new Set(chunkFiles.filter((f) => /^chunk_\d+\.json$/i.test(f)));

      const chunkMap = new Map();
      for (const wav of wavFiles) {
        const match = wav.match(/^chunk_(\d+)\.wav$/i);
        if (!match) continue;
        const idx = Number(match[1]);
        const txtName = `chunk_${match[1]}.txt`;
        const jsonName = `chunk_${match[1]}.json`;
        let text = '';
        if (txtFiles.has(txtName)) {
          try { text = fs.readFileSync(path.join(fullChunkPath, txtName), 'utf8').trim(); } catch {}
        }
        let chunkMeta = null;
        if (jsonFiles.has(jsonName)) {
          try { chunkMeta = JSON.parse(fs.readFileSync(path.join(fullChunkPath, jsonName), 'utf8')); } catch {}
        }
        const relPath = `03_audio/takes/${primaryChunkDir}/${wav}`;
        const fileStat = fs.statSync(path.join(fullChunkPath, wav));
        chunkMap.set(idx, {
          index: idx,
          filename: wav,
          relativePath: relPath,
          url: `/media/${encodeURIComponent(projectKey)}/${relPath.split('/').map(encodeURIComponent).join('/')}`,
          size: fileStat.size,
          text,
          duration: chunkMeta?.audio_seconds || (fileStat.size > 44 ? Number(((fileStat.size - 44) / (24000 * 2)).toFixed(2)) : 0),
          generationSeconds: chunkMeta?.generation_seconds || null,
          rtf: chunkMeta?.rtf || null,
          status: 'completed',
        });
      }

      if (activeTakeReport?.data?.chunks && Array.isArray(activeTakeReport.data.chunks)) {
        for (const meta of activeTakeReport.data.chunks) {
          const idx = meta.index;
          if (chunkMap.has(idx)) {
            const existing = chunkMap.get(idx);
            if (meta.audio_seconds) existing.duration = Number(meta.audio_seconds.toFixed(2));
            if (meta.generation_seconds) existing.generationSeconds = Number(meta.generation_seconds.toFixed(2));
            if (meta.rtf) existing.rtf = Number(meta.rtf.toFixed(2));
            if (meta.characters) existing.characters = meta.characters;
          }
        }
      }

      chunksComplete = chunkMap.size;
      chunksTotal = Math.max(chunksTotal, chunksComplete);

      for (let i = 1; i <= Math.max(chunksTotal, chunksComplete); i++) {
        if (chunkMap.has(i)) {
          chunks.push(chunkMap.get(i));
        } else {
          chunks.push({
            index: i,
            filename: `chunk_${String(i).padStart(4, '0')}.wav`,
            relativePath: `03_audio/takes/${primaryChunkDir}/chunk_${String(i).padStart(4, '0')}.wav`,
            url: null,
            size: 0,
            text: '',
            duration: 0,
            status: 'pending',
          });
        }
      }
    }
    // A prepared transcript is useful before any expensive TTS run.  It is the
    // canonical review queue; audio checkpoints overlay it as they arrive.
    if (Array.isArray(narrationManifest?.chunks)) {
      // Overlay only checkpoints whose exact compiled text matches this
      // manifest.  This prevents an old script's audio from being counted as
      // progress, while preserving valid resumable progress for this revision.
      const generated = new Map(chunks.map((chunk) => [chunk.index, chunk]));
      chunks.length = 0;
      chunksComplete = 0;
      for (const item of narrationManifest.chunks) {
        const checkpoint = generated.get(item.index);
        const matchesManifest = checkpoint && String(checkpoint.text || '').trim() === String(item.text || '').trim();
        if (matchesManifest) {
          chunks.push({ ...checkpoint, id: item.id, words: item.words, sourceLines: item.sourceLines, status: 'completed' });
          chunksComplete += 1;
        } else {
          chunks.push({
            index: item.index, id: item.id, filename: `chunk_${String(item.index).padStart(4, '0')}.wav`,
            relativePath: null, url: null, size: 0, text: item.text, words: item.words,
            sourceLines: item.sourceLines, duration: 0, status: 'prepared',
          });
        }
      }
      chunksTotal = chunks.length;
    }

    // 4. Music Tracks
    const musicTracks = [];
    const scanMediaDir = (relDir) => {
      const fullDir = path.join(projectPath, relDir);
      if (!fs.existsSync(fullDir)) return;
      for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isFile() && /\.(wav|mp3|m4a|flac|ogg)$/i.test(entry.name)) {
          const fullPath = path.join(fullDir, entry.name);
          const stat = fs.statSync(fullPath);
          const relativePath = `${relDir}/${entry.name}`;
          musicTracks.push({
            filename: entry.name,
            relativePath,
            url: `/media/${encodeURIComponent(projectKey)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subDir = path.join(fullDir, entry.name);
          for (const subFile of fs.readdirSync(subDir)) {
            if (subFile.startsWith('.')) continue;
            if (/\.(wav|mp3|m4a|flac|ogg)$/i.test(subFile)) {
              const fullPath = path.join(subDir, subFile);
              const stat = fs.statSync(fullPath);
              const relativePath = `${relDir}/${entry.name}/${subFile}`;
              musicTracks.push({
                filename: subFile,
                relativePath,
                url: `/media/${encodeURIComponent(projectKey)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
                size: stat.size,
                mtime: stat.mtimeMs,
              });
            }
          }
        }
      }
    };
    scanMediaDir('03_audio/music');
    scanMediaDir('03_audio/processed');

    // 5. Mixes & Masters
    const mixes = [];
    const mixesDir = path.join(audioDir, 'mixes');
    if (fs.existsSync(mixesDir)) {
      for (const file of fs.readdirSync(mixesDir)) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(mixesDir, file);
        const stat = fs.statSync(fullPath);
        const relativePath = `03_audio/mixes/${file}`;
        mixes.push({
          filename: file,
          relativePath,
          url: `/media/${encodeURIComponent(projectKey)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
          size: stat.size,
          mtime: stat.mtimeMs,
          isAudio: /\.(wav|mp3|m4a)$/i.test(file),
          isJson: file.endsWith('.json'),
        });
      }
    }
    mixes.sort((a, b) => b.mtime - a.mtime);

    // 6. Voice Profile & Candidates
    ensureDefaultAudioProfiles(projectPath, projectKey);
    const activeProfile = existingVoiceProfile(projectPath, project);
    const allProfiles = readAudioProfiles(projectPath);

    // 7. Full Categorized Audio Library
    const library = [];
    const addLibItem = (item, category) => library.push({ ...item, category });

    for (const t of takeAudioFiles) {
      addLibItem({ name: t.filename, relativePath: t.relativePath, url: t.url, size: t.size, type: 'take', isAudio: true }, 'voice');
    }
    for (const c of chunks.filter((c) => c.status === 'completed')) {
      addLibItem({ name: c.filename, relativePath: c.relativePath, url: c.url, size: c.size, type: 'chunk', isAudio: true, duration: c.duration, text: c.text }, 'chunks');
    }
    for (const m of musicTracks) {
      addLibItem({ name: m.filename, relativePath: m.relativePath, url: m.url, size: m.size, type: 'music', isAudio: true }, 'music');
    }
    for (const mx of mixes) {
      addLibItem({ name: mx.filename, relativePath: mx.relativePath, url: mx.url, size: mx.size, type: 'mix', isAudio: mx.isAudio, isJson: mx.isJson }, 'mixes');
    }
    if (planRelative) {
      const pStat = fs.statSync(path.join(projectPath, planRelative));
      addLibItem({ name: planName, relativePath: planRelative, url: `/media/${encodeURIComponent(projectKey)}/${planRelative}`, size: pStat.size, type: 'plan', isJson: true }, 'plans');
    }
    if (fs.existsSync(configPath)) {
      const cStat = fs.statSync(configPath);
      addLibItem({ name: 'audio_pipeline.json', relativePath: '03_audio/audio_pipeline.json', url: `/media/${encodeURIComponent(projectKey)}/03_audio/audio_pipeline.json`, size: cStat.size, type: 'config', isJson: true }, 'plans');
    }

    // 8. Active Runs Check
    const activeRuns = store.listRuns(projectKey).filter((r) => r.stageId === 'audio' && ['running', 'queued'].includes(r.status));
    const activeRun = activeRuns[0] || null;

    if (activeRun && activeRun.substage === 'voice') {
      const nextIdx = chunksComplete + 1;
      const genChunk = chunks.find((c) => c.index === nextIdx);
      if (genChunk) genChunk.status = 'generating';
    }

    // Resolve Blueprint for Music Timings ("where to where that music is required to be")
    let blueprint = null;
    if (plan?.basis) {
      const bpRel = `04_visuals/plans/${plan.basis}.json`;
      const bpPath = path.join(projectPath, bpRel);
      if (fs.existsSync(bpPath)) {
        try { blueprint = JSON.parse(fs.readFileSync(bpPath, 'utf8')); } catch {}
      }
    }
    if (!blueprint) {
      const bpDir = path.join(projectPath, '04_visuals', 'plans');
      if (fs.existsSync(bpDir)) {
        const bpFiles = fs.readdirSync(bpDir).filter((f) => f.startsWith('editorial_blueprint_') && f.endsWith('.json')).sort().reverse();
        if (bpFiles[0]) {
          try { blueprint = JSON.parse(fs.readFileSync(path.join(bpDir, bpFiles[0]), 'utf8')); } catch {}
        }
      }
    }

    const musicCueTimings = new Map();
    if (blueprint && Array.isArray(blueprint.beats)) {
      for (const beat of blueprint.beats) {
        const m = beat.audio?.musicCueId;
        if (m) {
          const s = Number(beat.timing?.startSeconds || 0);
          const e = Number(beat.timing?.endSeconds || s);
          if (!musicCueTimings.has(m)) {
            musicCueTimings.set(m, { startSeconds: s, endSeconds: e, beats: [beat.id] });
          } else {
            const entry = musicCueTimings.get(m);
            entry.startSeconds = Math.min(entry.startSeconds, s);
            entry.endSeconds = Math.max(entry.endSeconds, e);
            entry.beats.push(beat.id);
          }
        }
      }
    }

    const formatSec = (sec) => {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const enrichedMusicCues = (plan?.musicCues || []).map((cue) => {
      const timing = musicCueTimings.get(cue.id) || {};
      const startSeconds = timing.startSeconds ?? cue.startSeconds ?? 0;
      const endSeconds = timing.endSeconds ?? cue.endSeconds ?? 0;
      const durationSeconds = Number(Math.max(0, endSeconds - startSeconds).toFixed(1));
      const matchedTrack = musicTracks.find((t) => t.filename.includes(cue.id) || t.filename.toLowerCase().includes(cue.id.toLowerCase()));

      return {
        ...cue,
        startSeconds,
        endSeconds,
        durationSeconds,
        startFormatted: formatSec(startSeconds),
        endFormatted: formatSec(endSeconds),
        beats: timing.beats || [],
        beatRange: timing.beats?.length ? `${timing.beats[0]}–${timing.beats[timing.beats.length - 1]} (${timing.beats.length} beats)` : '',
        audioTrack: matchedTrack || null,
        status: matchedTrack ? 'ready' : 'planned',
      };
    });

    const allCues = Array.isArray(plan?.cues) && plan.cues.length > 0
      ? plan.cues
      : [...(enrichedMusicCues.length > 0 ? enrichedMusicCues : (plan?.musicCues || [])), ...(Array.isArray(plan?.sfx) ? plan.sfx : [])];

    const summary = {
      totalChunks: chunksTotal,
      completedChunks: chunksComplete,
      percent: chunksTotal > 0 ? Math.round((chunksComplete / chunksTotal) * 100) : 0,
      activeRun: activeRun ? { id: activeRun.id, substage: activeRun.substage, status: activeRun.status } : null,
      hasMasterMix: mixes.some((m) => m.filename.startsWith('final_mix') || m.filename.startsWith('review_mix')),
      cuesCount: enrichedMusicCues.length || allCues.length,
      activeVoiceLabel: activeProfile?.filename || activeProfile?.label || 'Default Voice',
    };

    return sendJson(response, 200, {
      plan,
      planVersion: planName ? audioPlanVersion(planName) : 1,
      planPath: planRelative,
      pipelineConfig,
      narrationManifest: narrationManifest ? { relativePath: `03_audio/plans/${narrationPlans.at(-1)}`, validation: narrationManifest.validation, source: narrationManifest.source } : null,
      narrationReview,
      summary,
      chunks,
      primaryChunkDir,
      takeReports,
      takeAudioFiles,
      musicTracks,
      musicCues: enrichedMusicCues,
      availableMusicProviders: [
        { id: 'ace_step', name: 'ACE-Step 1.5 (ComfyUI Turbo)', defaultApiUrl: 'http://127.0.0.1:8188' },
        { id: 'yue', name: 'YuE2-3B (ComfyUI Stereo)', defaultApiUrl: 'http://127.0.0.1:8188' },
      ],
      mixes,
      activeProfile,
      profiles: allProfiles,
      library,
    });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/pipeline$/);
  if (match && request.method === 'PATCH') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const body = await readBody(request);
    let configPath;
    if (body.music) {
      configPath = ensureMusicPipelineConfig({ projectKey, project, projectPath, provider: body.music.provider });
    } else {
      configPath = ensureVoicePipelineConfig({ projectKey, project, projectPath });
    }
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (body.voice && typeof body.voice === 'object') {
      current.voice = { ...current.voice, ...body.voice };
    }
    if (body.music && typeof body.music === 'object') {
      current.music = { ...current.music, ...body.music };
    }
    writeAtomic(configPath, `${JSON.stringify(current, null, 2)}\n`);
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath: '03_audio/audio_pipeline.json', content: JSON.stringify(current, null, 2), mimeType: MIME['.json'], provenance: { action: 'update_audio_pipeline' } });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { pipelineConfig: current });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/narration\/compile$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const configPath = ensureVoicePipelineConfig({ projectKey, project, projectPath });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const configuredSource = String(config.voice?.text_file || '');
    const source = path.isAbsolute(configuredSource)
      ? fs.realpathSync(configuredSource)
      : resolveContained(PROJECT_ROOT, configuredSource, { mustExist: true });
    if (!source.startsWith(`${projectPath}${path.sep}`)) throw Object.assign(new Error('Configured narration script is outside this project'), { statusCode: 400 });
    const language = String(config.voice?.language || project.settings?.language || 'und');
    const output = path.join(projectPath, '03_audio', 'plans', `narration_${path.basename(source, path.extname(source))}.json`);
    const result = spawnSync(process.env.PYTHON || 'python3', [path.join(PROJECT_ROOT, 'tools', 'narration_compiler.py'), source, '--output', output, '--language', language, '--max-chars', String(Number(config.voice?.max_chars || 320))], { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw Object.assign(new Error((result.stderr || result.error?.message || 'Narration compilation failed').trim()), { statusCode: 422 });
    const relativePath = path.relative(projectPath, output);
    const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath, content: fs.readFileSync(output), mimeType: MIME['.json'], provenance: { action: 'compile_narration', source: path.relative(projectPath, source), narrationSha256: manifest.narration_sha256 } });
    // A new compilation is a new editorial object.  Prior approvals and take
    // bindings must never silently carry across a changed script.
    store.patchStage(projectKey, 'audio', { data: { narrationReview: { manifest: relativePath, narrationSha256: manifest.narration_sha256, status: 'prepared', chunkReviews: {} } } });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { manifest, relativePath });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/narration\/review$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const plansDir = path.join(projectPathForKey(projectKey), '03_audio', 'plans');
    const planName = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).filter((name) => /^narration_.*\.json$/i.test(name)).sort().at(-1) : null;
    if (!planName) throw Object.assign(new Error('Prepare narration chunks before approving review'), { statusCode: 409 });
    const manifest = JSON.parse(fs.readFileSync(path.join(plansDir, planName), 'utf8'));
    const approved = body.decision === 'approved';
    const review = {
      manifest: `03_audio/plans/${planName}`, narrationSha256: manifest.narration_sha256,
      status: approved ? 'approved' : 'changes_requested', approvedAt: approved ? new Date().toISOString() : null,
      note: String(body.note || '').trim().slice(0, 10_000), audit: body.audit && typeof body.audit === 'object' ? { manifest: body.audit.manifest, auditedAt: body.audit.auditedAt, findings: Array.isArray(body.audit.findings) ? body.audit.findings : [] } : null,
      chunkReviews: project.stages?.audio?.data?.narrationReview?.chunkReviews || {},
      activeTakeStem: project.stages?.audio?.data?.narrationReview?.activeTakeStem || null,
    };
    store.patchStage(projectKey, 'audio', { status: 'needs_review', data: { narrationReview: review } });
    return sendJson(response, 200, { review });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/narration\/chunks\/(\d+)\/review$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]); const index = Number(match[2]);
    const project = store.getProject(projectKey);
    if (!project || !Number.isInteger(index) || index < 1) throw Object.assign(new Error('Invalid narration chunk'), { statusCode: 400 });
    const body = await readBody(request);
    const review = project.stages?.audio?.data?.narrationReview;
    if (!review?.manifest) throw Object.assign(new Error('Prepare narration chunks before reviewing a chunk'), { statusCode: 409 });
    const chunkReviews = { ...(review.chunkReviews || {}), [index]: { status: body.decision === 'approved' ? 'approved' : 'changes_requested', note: String(body.note || '').trim().slice(0, 10_000), reviewedAt: new Date().toISOString() } };
    store.patchStage(projectKey, 'audio', { data: { narrationReview: { ...review, chunkReviews } } });
    return sendJson(response, 200, { review: chunkReviews[index] });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/voice\/generate$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const review = project.stages?.audio?.data?.narrationReview;
    if (review?.status !== 'approved') throw Object.assign(new Error('Prepare and approve the narration review before generating voiceover'), { statusCode: 409 });
    const config = ensureVoicePipelineConfig({ projectKey, project, projectPath });
    const takeStem = review.activeTakeStem || `voice_v${iterationTarget(projectPath, 'audio', project.settings?.language || 'hi', 'voice').version}_take_1`;
    const output = path.join(projectPath, '03_audio', 'takes', `${takeStem}.wav`);
    const run = jobs.enqueue({ project, stageId: 'audio', substage: 'voice', adapter: 'python', projectPath, resource: 'audio-model', inputHash: `voice:${review.narrationSha256}:${takeStem}`,
      commandSpec: { command: process.env.PYTHON || 'python3', args: [path.join(PROJECT_ROOT, 'tools', 'audio_pipeline.py'), config, 'voice', '--output', output], cwd: PROJECT_ROOT, timeoutMs: 2 * 60 * 60_000, expectedOutputs: [] } });
    store.patchStage(projectKey, 'audio', { data: { narrationReview: { ...review, activeTakeStem: takeStem } } });
    return sendJson(response, 202, { run, takeStem });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/chunks\/(\d+)\/generate$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const index = Number(match[2]);
    const project = store.getProject(projectKey);
    if (!project || !Number.isInteger(index) || index < 1) throw Object.assign(new Error('Invalid narration chunk'), { statusCode: 400 });
    const projectPath = projectPathForKey(projectKey);
    const review = project.stages?.audio?.data?.narrationReview;
    if (review?.status !== 'approved') throw Object.assign(new Error('Approve the narration review before generating voiceover'), { statusCode: 409 });
    const config = ensureVoicePipelineConfig({ projectKey, project, projectPath });
    const takeStem = review.activeTakeStem || `voice_v${iterationTarget(projectPath, 'audio', project.settings?.language || 'hi', 'voice').version}_take_1`;
    const output = path.join(projectPath, '03_audio', 'takes', `${takeStem}.wav`);
    const run = jobs.enqueue({ project, stageId: 'audio', substage: 'voice', adapter: 'python', projectPath, resource: 'audio-model', inputHash: `single-chunk:${index}`,
      commandSpec: { command: process.env.PYTHON || 'python3', args: [path.join(PROJECT_ROOT, 'tools', 'audio_pipeline.py'), config, 'voice', '--output', output, '--only-chunk', String(index), '--force-chunk', String(index), '--one-batch'], cwd: PROJECT_ROOT, timeoutMs: 2 * 60 * 60_000, expectedOutputs: [] } });
    store.patchStage(projectKey, 'audio', { data: { narrationReview: { ...review, activeTakeStem: takeStem } } });
    return sendJson(response, 202, { run, index });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/music\/generate$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const body = await readBody(request).catch(() => ({}));
    const configPath = ensureMusicPipelineConfig({ projectKey, project, projectPath, provider: body?.provider });
    const planName = latestAudioPlan(projectPath);
    const version = audioPlanVersion(planName) || 1;
    const suffix = `_v${version}_take_1`;
    const args = [path.join(PROJECT_ROOT, 'tools', 'audio_pipeline.py'), configPath, 'music', '--suffix', suffix];
    if (body?.cue) {
      args.push('--cue', String(body.cue));
    }
    if (body?.overwrite) {
      args.push('--overwrite-music');
    }
    if (body?.dryRun) {
      args.push('--dry-run');
    }
    const run = jobs.enqueue({ project, stageId: 'audio', substage: 'music', adapter: 'python', projectPath, resource: 'audio-model', inputHash: `music:${planName}:${body?.cue || 'all'}:${suffix}:${Date.now()}`,
      commandSpec: { command: process.env.PYTHON || 'python3', args, cwd: PROJECT_ROOT, timeoutMs: 2 * 60 * 60_000, expectedOutputs: [] } });
    return sendJson(response, 202, { run, suffix });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/audio\/narration\/audit$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const plansDir = path.join(projectPathForKey(projectKey), '03_audio', 'plans');
    const planName = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).filter((name) => /^narration_.*\.json$/i.test(name)).sort().at(-1) : null;
    if (!planName) throw Object.assign(new Error('Prepare narration chunks before auditing'), { statusCode: 409 });
    const manifest = JSON.parse(fs.readFileSync(path.join(plansDir, planName), 'utf8'));
    const allowed = new Set(['nyāya', 'dharmakīrti', 'dharmottara', 'mīmāṃsā', 'vātsyāyana', 'viśvanātha', 'cārvāka', 'lokāyata', 'jayarāśi', 'saindhava', 'arthāpatti', 'pramā', 'pramāṇa', 'vyāpti', 'upādhi', 'bādha']);
    const findings = [];
    for (const chunk of manifest.chunks || []) {
      const words = String(chunk.text || '').match(/[A-Za-z][A-Za-zāīūṛṅñṭḍṇśṣṃṁ-]*/g) || [];
      const unexpected = [...new Set(words.filter((word) => !allowed.has(word.toLowerCase()) && word.length > 2))];
      if (unexpected.length) findings.push({ chunk: chunk.index, severity: 'review', kind: 'latin_script', message: `Review English/Latin-script narration: ${unexpected.slice(0, 8).join(', ')}`, suggestion: 'Keep only intentional proper names/transliterations; translate ordinary prose into Hindi.' });
      if (chunk.words > 70) findings.push({ chunk: chunk.index, severity: 'review', kind: 'pacing', message: `${chunk.words} words may be long for one delivery`, suggestion: 'Listen first; split only if performance feels rushed.' });
    }
    const audit = { schemaVersion: 1, manifest: `03_audio/plans/${planName}`, auditedAt: new Date().toISOString(), chunks: (manifest.chunks || []).length, findings, summary: findings.length ? `${findings.length} exception(s) need attention; the remaining chunks need no individual review.` : 'No deterministic exceptions found.' };
    const relativePath = '03_audio/plans/narration_audit_v1.json';
    writeAtomic(path.join(projectPathForKey(projectKey), relativePath), `${JSON.stringify(audit, null, 2)}\n`);
    store.recordArtifact({ projectKey, stageId: 'audio', relativePath, content: JSON.stringify(audit, null, 2), mimeType: MIME['.json'], provenance: { action: 'audit_narration', manifest: audit.manifest } });
    return sendJson(response, 200, audit);
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/visuals\/manifest$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const filesystem = scanProject(projectPath);
    const planRelative = [...filesystem.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item)) || '04_visuals/plans/asset_plan_v1.json';
    const planFile = path.join(projectPath, planRelative);
    let planData = [];
    if (fs.existsSync(planFile)) {
      try { planData = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch {}
    }
    const rendersDir = path.join(projectPath, '04_visuals', 'renders');
    const thumbnailsDir = path.join(projectPath, '04_visuals', 'thumbnails');
    const briefPath = path.join(thumbnailsDir, 'brief.md');
    const thumbnailBrief = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, 'utf8') : '';

    const loadedBlueprint = readEditorialBlueprint(projectPath, project);
    const beatLinks = new Map((loadedBlueprint.blueprint?.beats || []).map((beat) => [beat.visual?.primaryAssetId, beat.id]).filter(([id]) => id));
    const assets = (Array.isArray(planData) ? planData : []).map((item, idx) => {
      const id = item.id || `ASSET_${String(idx + 1).padStart(3, '0')}`;
      const renderFile = path.join(rendersDir, `${id}.png`);
      const exists = fs.existsSync(renderFile);
      const size = exists ? fs.statSync(renderFile).size : 0;
      return {
        id,
        type: (item.type || 'GEN').toUpperCase(),
        description: item.description || '',
        prompt: item.prompt || '',
        sourceSuggestion: item.sourceSuggestion || null,
        generatedPath: exists ? `04_visuals/renders/${id}.png` : (item.generatedPath || null),
        imageUrl: exists ? `/media/${encodeURIComponent(projectKey)}/04_visuals/renders/${encodeURIComponent(id)}.png?t=${fs.statSync(renderFile).mtimeMs}` : null,
        exists,
        size,
        resolution: item.resolution || (exists ? (item.upscaled ? '1920x1080' : '1280x720') : null),
        upscaled: Boolean(item.upscaled),
        approvalStatus: item.approvalStatus || (item.selected ? 'approved' : 'pending'),
        beatId: beatLinks.get(id) || null,
      };
    });

    const thumbnails = fs.existsSync(thumbnailsDir)
      ? fs.readdirSync(thumbnailsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => ({
          filename: f,
          url: `/media/${encodeURIComponent(projectKey)}/04_visuals/thumbnails/${encodeURIComponent(f)}`,
        }))
      : [];

    const summary = {
      total: assets.length,
      rendered: assets.filter((a) => a.exists).length,
      approved: assets.filter((a) => a.approvalStatus === 'approved').length,
      upscaled: assets.filter((a) => a.upscaled).length,
    };

    return sendJson(response, 200, { planPath: planRelative, assets, summary, thumbnailBrief, thumbnails });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/visuals\/asset$/);
  if (match && request.method === 'PATCH') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const { assetId, prompt, description, approvalStatus, selected } = body;
    if (!assetId) throw Object.assign(new Error('assetId is required'), { statusCode: 400 });
    const projectPath = projectPathForKey(projectKey);
    const filesystem = scanProject(projectPath);
    const planRelative = [...filesystem.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item)) || '04_visuals/plans/asset_plan_v1.json';
    const planFile = path.join(projectPath, planRelative);
    if (!fs.existsSync(planFile)) throw Object.assign(new Error('Asset plan not found'), { statusCode: 404 });
    const planData = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const item = planData.find((a, idx) => (a.id || `ASSET_${String(idx + 1).padStart(3, '0')}`) === assetId);
    if (!item) throw Object.assign(new Error(`Asset ${assetId} not found in plan`), { statusCode: 404 });
    if (prompt !== undefined) item.prompt = String(prompt);
    if (description !== undefined) item.description = String(description);
    if (approvalStatus !== undefined) item.approvalStatus = approvalStatus;
    if (selected !== undefined) item.selected = Boolean(selected);
    writeAtomic(planFile, JSON.stringify(planData, null, 2));
    store.recordArtifact({
      projectKey,
      stageId: 'assets',
      relativePath: planRelative,
      content: JSON.stringify(planData, null, 2),
      mimeType: 'application/json; charset=utf-8',
      provenance: { editedIn: 'visuals_studio', assetId },
    });
    broadcast('project_updated', { projectKey });
    return sendJson(response, 200, { ok: true, asset: item });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/visuals\/render-single$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const { assetId, prompt } = body;
    if (!assetId) throw Object.assign(new Error('assetId is required'), { statusCode: 400 });
    if (prompt) {
      const projectPath = projectPathForKey(projectKey);
      const filesystem = scanProject(projectPath);
      const planRelative = [...filesystem.stages.assets.files].reverse().find((item) => PATTERNS.assetPlan.test(item)) || '04_visuals/plans/asset_plan_v1.json';
      const planFile = path.join(projectPath, planRelative);
      if (fs.existsSync(planFile)) {
        try {
          const planData = JSON.parse(fs.readFileSync(planFile, 'utf8'));
          const item = planData.find((a, idx) => (a.id || `ASSET_${String(idx + 1).padStart(3, '0')}`) === assetId);
          if (item) {
            item.prompt = String(prompt);
            writeAtomic(planFile, JSON.stringify(planData, null, 2));
          }
        } catch {}
      }
    }
    if (body.dryRun === true) return sendJson(response, 202, { ok: true, run: { id: null, projectKey, stageId: 'visuals', substage: 'generate', status: 'dry_run', adapter: 'python' } });
    const run = queueStageRun({
      projectKey,
      stageId: 'visuals',
      substage: 'generate',
      adapter: 'python',
      iterationNote: `--asset-id ${assetId} --force`,
      skipRequirementsCheck: true,
    });
    return sendJson(response, 202, { ok: true, run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/visuals\/upscale-selected$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    if (body.dryRun === true) return sendJson(response, 202, { ok: true, run: { id: null, projectKey, stageId: 'visuals', substage: 'generate', status: 'dry_run', adapter: 'python' } });
    const run = queueStageRun({
      projectKey,
      stageId: 'visuals',
      substage: 'generate',
      adapter: 'python',
      iterationNote: `--upscale-selected`,
      skipRequirementsCheck: true,
    });
    return sendJson(response, 202, { ok: true, run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/visuals\/upscale-single$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const body = await readBody(request);
    const { assetId } = body;
    if (!assetId) throw Object.assign(new Error('assetId is required'), { statusCode: 400 });
    if (body.dryRun === true) return sendJson(response, 202, { ok: true, run: { id: null, projectKey, stageId: 'visuals', substage: 'generate', status: 'dry_run', adapter: 'python' } });
    const run = queueStageRun({
      projectKey,
      stageId: 'visuals',
      substage: 'generate',
      adapter: 'python',
      iterationNote: `--upscale-asset ${assetId}`,
      skipRequirementsCheck: true,
    });
    return sendJson(response, 202, { ok: true, run });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/stages\/([^/]+)$/);
  if (match && request.method === 'PATCH') {
    const projectKey = assertProjectKey(match[1]);
    const stageId = assertId(match[2], 'stage');
    if (!STAGE_IDS.has(stageId)) throw Object.assign(new Error('Invalid stage'), { statusCode: 400 });
    const body = await readBody(request);
    const allowed = {};
    if (body.agent !== undefined) {
      if (body.agent !== null && !AGENTS[body.agent]) throw Object.assign(new Error('Invalid agent'), { statusCode: 400 });
      if (body.agent && !AGENTS[body.agent].stages.includes('*') && !AGENTS[body.agent].stages.includes(stageId)) throw Object.assign(new Error(`${AGENTS[body.agent].label} is not available for this stage`), { statusCode: 400 });
      allowed.agent = body.agent;
    }
    if (body.autoMode !== undefined) allowed.autoMode = Boolean(body.autoMode);
    if (body.promptOverride !== undefined) allowed.promptOverride = body.promptOverride === null ? null : String(body.promptOverride).slice(0, 100_000);
    if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) allowed.data = body.data;
    const updatedStage = store.patchStage(projectKey, stageId, allowed);
    const workflow = allowed.autoMode ? startManualAutomationIfEligible(projectKey) : null;
    return sendJson(response, 200, { stage: updatedStage, workflow });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/stages\/([^/]+)\/approve$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const stageId = assertId(match[2], 'stage');
    if (!STAGE_IDS.has(stageId)) throw Object.assign(new Error('Invalid stage'), { statusCode: 400 });
    const body = await readBody(request);
    const decision = body.decision === 'changes_requested' ? 'changes_requested' : body.decision === 'approved' ? 'approved' : null;
    if (!decision) throw Object.assign(new Error('Decision must be approved or changes_requested'), { statusCode: 400 });
    if (stageId === 'publish') throw Object.assign(new Error('Publish is approved only after a verified upload'), { statusCode: 409 });
    const stageState = store.getProject(projectKey)?.stages?.[stageId];
    if (!stageState || ['blocked', 'queued', 'running'].includes(stageState.status)) throw Object.assign(new Error('This stage is not ready for review'), { statusCode: 409 });
    if (decision === 'approved') {
      ensureRequirements(store.getProject(projectKey), STAGES.find((stage) => stage.id === stageId));
      syncArtifacts(projectKey, stageId);
      const problems = validateStageForApproval(projectKey, stageId);
      if (problems.length) throw Object.assign(new Error(problems.join('; ')), { statusCode: 409 });
    }
    const approved = store.approve({ projectKey, stageId, artifactRevisionId: body.artifactRevisionId || null, decision, note: String(body.note || '') });
    const workflow = decision === 'approved' ? startManualAutomationIfEligible(projectKey) : null;
    return sendJson(response, 200, { project: approved, workflow });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/stages\/([^/]+)\/adopt$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const stageId = assertId(match[2], 'stage');
    if (!STAGE_IDS.has(stageId) || stageId === 'publish') throw Object.assign(new Error('This stage cannot be adopted'), { statusCode: 400 });
    ensureRequirements(store.getProject(projectKey), STAGES.find((stage) => stage.id === stageId));
    syncArtifacts(projectKey, stageId);
    const problems = validateStageForApproval(projectKey, stageId);
    if (problems.length) throw Object.assign(new Error(problems.join('; ')), { statusCode: 409 });
    const project = store.approve({ projectKey, stageId, decision: 'approved', note: 'Adopted from validated filesystem artifacts' });
    return sendJson(response, 200, { project, filesystem: scanProject(projectPathForKey(projectKey)) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/history$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    projectPathForKey(projectKey);
    const relativePath = assertRelativePath(url.searchParams.get('path'));
    return sendJson(response, 200, { revisions: store.listArtifactRevisions(projectKey, relativePath) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/restore$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const projectPath = projectPathForKey(projectKey);
    const body = await readBody(request);
    const revision = store.getArtifactRevision(projectKey, String(body.revisionId || ''));
    if (!revision) throw Object.assign(new Error('Artifact revision not found'), { statusCode: 404 });
    if (!revision.content) throw Object.assign(new Error('This binary or legacy revision cannot be restored in the studio'), { statusCode: 409 });
    const safePath = assertRelativePath(revision.relativePath);
    const file = resolveContained(projectPath, safePath);
    if (fs.existsSync(file)) {
      const archive = path.join(projectPath, '99_archive', 'revisions', `${Date.now()}_${safePath.replaceAll('/', '__')}`);
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      fs.copyFileSync(file, archive);
    }
    writeAtomic(file, revision.content);
    const restored = store.recordArtifact({ projectKey, stageId: revision.stageId, relativePath: safePath, content: revision.content, mimeType: revision.mimeType, provenance: { restoredFromRevision: revision.revision } });
    store.patchStage(projectKey, revision.stageId, { status: 'needs_review' });
    return sendJson(response, 200, { revision: restored, artifacts: store.listArtifacts(projectKey, revision.stageId) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/);
  if (match) {
    const projectKey = assertProjectKey(match[1]);
    const projectPath = projectPathForKey(projectKey);
    const relativePath = url.searchParams.get('path');
    if (request.method === 'GET' && !relativePath) {
      const stageId = url.searchParams.get('stage');
      if (stageId && !STAGE_IDS.has(stageId)) throw Object.assign(new Error('Invalid stage'), { statusCode: 400 });
      return sendJson(response, 200, { artifacts: syncArtifacts(projectKey, stageId) });
    }
    if (!relativePath) throw Object.assign(new Error('Artifact path is required'), { statusCode: 400 });
    const safePath = assertRelativePath(relativePath);
    const file = resolveContained(projectPath, safePath, { mustExist: request.method === 'GET' });
    if (request.method === 'GET') return serveMedia(request, response, file);
    if (request.method === 'PUT') {
      const extension = path.extname(file).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) throw Object.assign(new Error('Only text artifacts can be edited'), { statusCode: 415 });
      const body = await readBody(request);
      if (typeof body.content !== 'string') throw Object.assign(new Error('Artifact content must be text'), { statusCode: 400 });
      const stageId = String(body.stageId || 'idea');
      if (!STAGE_IDS.has(stageId)) throw Object.assign(new Error('Invalid stage'), { statusCode: 400 });
      if (fs.existsSync(file)) {
        const archive = path.join(projectPath, '99_archive', 'revisions', `${Date.now()}_${safePath.replaceAll('/', '__')}`);
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        fs.copyFileSync(file, archive);
      }
      writeAtomic(file, body.content);
      const revision = store.recordArtifact({ projectKey, stageId, relativePath: safePath, content: body.content, mimeType: MIME[extension] || 'text/plain; charset=utf-8', provenance: { editedIn: 'chitra-yantra' } });
      store.patchStage(projectKey, stageId, { status: 'needs_review' });
      return sendJson(response, 200, { revision, artifacts: store.listArtifacts(projectKey, stageId) });
    }
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
  if (match && request.method === 'GET') return sendJson(response, 200, { runs: store.listRuns(assertProjectKey(match[1])) });

  match = pathname.match(/^\/api\/projects\/([^/]+)\/autopilot$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const body = await readBody(request);
    const initial = store.getProject(projectKey);
    if (!initial) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const requested = body.startStage ? assertId(body.startStage, 'stage') : null;
    if (requested && !STAGE_IDS.has(requested)) throw Object.assign(new Error('Invalid start stage'), { statusCode: 400 });
    const candidate = requested ? STAGES.find((item) => item.id === requested) : STAGES.find((item) => item.id !== 'publish' && initial.stages[item.id]?.status !== 'approved');
    if (!candidate) throw Object.assign(new Error('All production stages are approved'), { statusCode: 409 });
    const ideaData = initial.stages.idea?.data || {};
    const workflow = automation.start({ projectKey, mode: 'global', origin: 'gui', startStage: candidate.id,
      topic: candidate.id === 'idea' ? ideaData.topicDescription : null, proactive: candidate.id === 'idea' && ideaData.planningMode !== 'guided' });
    return sendJson(response, 202, { project: store.getProject(projectKey), workflow, started: true });
  }

  if (pathname === '/api/jobs' && request.method === 'POST') {
    const body = await readBody(request);
    const run = queueStageRun({ projectKey: assertProjectKey(body.projectKey), stageId: body.stageId, substage: body.substage, adapter: body.adapter, customPrompt: body.customPrompt, manualSources: body.manualSources, planningMode: body.planningMode, topicDescription: body.topicDescription, iterationNote: String(body.iterationNote || '').slice(0, 20_000), parentArtifact: body.parentArtifact, parentIndex: body.parentIndex, parentTitle: body.parentTitle, language: body.language, skipRequirementsCheck: Boolean(body.skipRequirementsCheck) });
    return sendJson(response, 202, { run });
  }

  match = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
  if (match && request.method === 'DELETE') {
    if (!jobs.cancel(match[1])) throw Object.assign(new Error('Active job not found'), { statusCode: 404 });
    return sendJson(response, 202, { cancelled: true });
  }
  match = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/log$/);
  if (match && request.method === 'GET') {
    const run = store.getRun(match[1]);
    if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    let content = '';
    try { content = fs.readFileSync(run.logPath, 'utf8').slice(-250_000); } catch { /* no output yet */ }
    return sendJson(response, 200, { run, content });
  }

  if (pathname === '/api/youtube/status' && request.method === 'GET') {
    const helper = path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py');
    const token = path.join(PROJECT_ROOT, 'youtube-mcp', '.secrets', 'token.json');
    const client = path.join(PROJECT_ROOT, 'youtube-mcp', '.secrets', 'client_secret.json');
    const configured = fs.existsSync(client);
    const tokenPresent = fs.existsSync(token);
    const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
    if (!configured || !tokenPresent || !fs.existsSync(helper) || !fs.existsSync(python)) {
      return sendJson(response, 200, { configured, authenticated: false, helperAvailable: fs.existsSync(helper), environmentAvailable: fs.existsSync(python) });
    }
    const result = await runJsonCommand(python, [helper, 'status'], path.join(PROJECT_ROOT, 'youtube-mcp'));
    return sendJson(response, 200, { configured, authenticated: Boolean(result.success), helperAvailable: true, environmentAvailable: true, channel: result.channel || null, error: result.error || null });
  }

  if (pathname === '/api/youtube/auth' && request.method === 'POST') {
    const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
    if (!fs.existsSync(python)) throw Object.assign(new Error('YouTube environment is not installed'), { statusCode: 503 });
    const child = spawn(python, [path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py'), 'auth'], { cwd: path.join(PROJECT_ROOT, 'youtube-mcp'), detached: true, stdio: 'ignore', shell: false });
    child.unref();
    return sendJson(response, 202, { started: true, message: 'Complete authorization in the browser, then refresh status.' });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/analytics$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const publication = store.listPublications(projectKey).find((item) => item.remoteId);
    if (!publication) throw Object.assign(new Error('Publish the video before requesting analytics'), { statusCode: 409 });
    const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
    const helper = path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py');
    if (!fs.existsSync(python)) throw Object.assign(new Error('YouTube environment is not installed'), { statusCode: 503 });
    const result = await runJsonCommand(python, [helper, 'analytics', '--video-id', publication.remoteId], path.join(PROJECT_ROOT, 'youtube-mcp'), 30000);
    if (!result.success) throw Object.assign(new Error(result.error || 'Analytics request failed'), { statusCode: 502 });
    const fetchedAt = new Date().toISOString();
    const ageHours = publication.createdAt ? Math.max(0, (Date.now() - new Date(publication.createdAt).getTime()) / 3_600_000) : 0;
    const milestones = [24, 72, 168, 720];
    const nextMilestone = milestones.find((hours) => hours > ageHours) || null;
    const snapshot = { schemaVersion: 1, fetchedAt, ageHours: Number(ageHours.toFixed(1)), maturity: ageHours < 168 ? 'directional' : 'developing', nextMilestoneHours: nextMilestone, ...result.analytics };
    const relativePath = '06_publish/analytics/latest.json';
    const content = JSON.stringify(snapshot, null, 2);
    writeAtomic(path.join(projectPathForKey(projectKey), relativePath), content);
    const snapshotPath = `06_publish/analytics/snapshot_${fetchedAt.replace(/[:.]/g, '-').replace('Z', 'Z')}.json`;
    writeAtomic(path.join(projectPathForKey(projectKey), snapshotPath), content);
    const postmortemPath = '06_publish/analytics/postmortem_draft_v1.json';
    const postmortem = { schemaVersion: 1, updatedAt: fetchedAt, maturity: snapshot.maturity, ageHours: snapshot.ageHours,
      signals: { views: result.analytics.views || 0, watchTimeHours: result.analytics.watch_time_hours || 0, averagePercentageWatched: result.analytics.average_percentage_watched || null },
      prompts: ['Did the title and thumbnail promise match the opening 30 seconds?', 'Where does retention fall and what narrative or visual event occurs there?', 'Which lesson should the owner approve for future episodes?'], ownerApprovedLessons: [] };
    writeAtomic(path.join(projectPathForKey(projectKey), postmortemPath), `${JSON.stringify(postmortem, null, 2)}\n`);
    store.recordArtifact({ projectKey, stageId: 'publish', relativePath, content, mimeType: 'application/json; charset=utf-8', provenance: { source: 'youtube-analytics-api' }, status: 'approved' });
    store.recordArtifact({ projectKey, stageId: 'publish', relativePath: snapshotPath, content, mimeType: 'application/json; charset=utf-8', provenance: { source: 'youtube-analytics-api', kind: 'milestone_snapshot' }, status: 'approved' });
    store.recordArtifact({ projectKey, stageId: 'publish', relativePath: postmortemPath, content: JSON.stringify(postmortem, null, 2), mimeType: 'application/json; charset=utf-8', provenance: { action: 'postmortem_draft' }, status: 'draft' });
    store.patchStage(projectKey, 'publish', { data: { analytics: result.analytics, analyticsFetchedAt: fetchedAt, analyticsMaturity: snapshot.maturity, nextAnalyticsMilestoneHours: nextMilestone } });
    return sendJson(response, 200, { analytics: snapshot, postmortemPath });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/release-manifest$/);
  if (match && request.method === 'GET') {
    const projectKey = assertProjectKey(match[1]);
    const projectPath = projectPathForKey(projectKey);
    const file = path.join(projectPath, '06_publish', 'release_manifest_v1.json');
    if (!fs.existsSync(file)) return sendJson(response, 200, { manifest: null, problems: ['Release manifest has not been created'] });
    const manifest = readJsonFile(file, 'Release manifest');
    return sendJson(response, 200, { manifest, problems: verifyReleaseManifest(projectPath, manifest), quality: (() => {
      try { return validateQualityReport(readJsonFile(path.join(projectPath, manifest.qualityReport.path), 'Quality report')); } catch (error) { return { valid: false, problems: [error.message] }; }
    })(), events: store.listReleaseEvents(projectKey) });
  }
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const session = getSession(request);
    const body = await readBody(request);
    const manifest = writeReleaseContract(projectKey, projectPathForKey(projectKey), body.selection || {}, session);
    return sendJson(response, 201, { manifest });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/release$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const projectPath = projectPathForKey(projectKey);
    const body = await readBody(request);
    const privacy = String(body.privacy || '');
    if (!['public', 'unlisted'].includes(privacy)) throw Object.assign(new Error('Owner release visibility must be public or unlisted'), { statusCode: 400 });
    const candidate = validatePrivateCandidate(projectKey, projectPath);
    const recommended = Number(project.settings?.ownerReleaseTarget || 90);
    const rationale = String(body.overrideRationale || '').trim();
    if ((candidate.quality.score < recommended || candidate.quality.unresolvedBlockers.length) && !rationale) {
      throw Object.assign(new Error(`A written override rationale is required below the owner target of ${recommended} or with unresolved blockers`), { statusCode: 409 });
    }
    if (!safeEqual(String(body.confirmation || ''), String(candidate.metadata.title || ''))) throw Object.assign(new Error('Type the exact release title to confirm'), { statusCode: 400 });
    const publication = store.listPublications(projectKey).find((item) => item.remoteId && item.privacy === 'private');
    if (!publication) throw Object.assign(new Error('A qualifying private YouTube candidate is required before release'), { statusCode: 409 });
    const requestFile = path.join(projectPath, '06_publish', `release_request_${publication.id}.json`);
    writeAtomic(requestFile, JSON.stringify({ videoId: publication.remoteId, privacy }, null, 2));
    const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
    const helper = path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py');
    const result = await runJsonCommand(python, [helper, 'release', '--request', requestFile], path.join(PROJECT_ROOT, 'youtube-mcp'), 30000);
    if (!result.success) throw Object.assign(new Error(result.error || 'YouTube visibility update failed'), { statusCode: 502 });
    store.finishPublication(publication.id, { status: privacy === 'public' ? 'released' : 'unlisted', remoteId: publication.remoteId, remoteUrl: publication.remoteUrl });
    const session = getSession(request);
    store.recordReleaseEvent({ projectKey, publicationId: publication.id, actor: session?.id || 'owner', action: `owner_release_${privacy}`, rationale, payload: { score: candidate.quality.score, target: recommended, manifest: '06_publish/release_manifest_v1.json' } });
    return sendJson(response, 200, { publicationId: publication.id, privacy, result: result.release || result });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/release\/reconcile$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const publication = store.listPublications(projectKey).find((item) => item.remoteId);
    if (!publication) throw Object.assign(new Error('No uploaded YouTube video is available to reconcile'), { statusCode: 409 });
    const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
    const result = await runJsonCommand(python, [path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py'), 'reconcile', '--video-id', publication.remoteId], path.join(PROJECT_ROOT, 'youtube-mcp'), 30000);
    if (!result.success) throw Object.assign(new Error(result.error || 'YouTube reconciliation failed'), { statusCode: 502 });
    const privacy = result.video?.privacy;
    if (['public', 'unlisted', 'private'].includes(privacy)) store.finishPublication(publication.id, { status: privacy === 'public' ? 'released' : privacy, remoteId: publication.remoteId, remoteUrl: publication.remoteUrl });
    const session = getSession(request);
    store.recordReleaseEvent({ projectKey, publicationId: publication.id, actor: session?.id || 'owner', action: 'youtube_studio_reconciled', payload: result.video || {} });
    return sendJson(response, 200, { publicationId: publication.id, remote: result.video });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/publish$/);
  if (match && request.method === 'POST') {
    const projectKey = assertProjectKey(match[1]);
    const project = store.getProject(projectKey);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const existingUpload = store.listPublications(projectKey).find((publication) => publication.remoteId);
    if (existingUpload) throw Object.assign(new Error(`This project is already uploaded${existingUpload.remoteUrl ? ` at ${existingUpload.remoteUrl}` : ''}; resolve any post-upload actions without creating a duplicate`), { statusCode: 409 });
    const body = await readBody(request);
    if (body.privacy && body.privacy !== 'private') throw Object.assign(new Error('This action only uploads a private candidate. Use the owner Release Console to change visibility.'), { statusCode: 403 });
    const projectPath = projectPathForKey(projectKey);
    const candidate = validatePrivateCandidate(projectKey, projectPath);
    const { manifest, metadata } = candidate;
    if (!safeEqual(String(body.confirmation || ''), String(metadata.title || ''))) throw Object.assign(new Error('Type the exact video title to confirm private candidate upload'), { statusCode: 400 });
    const video = path.join(projectPath, manifest.artifacts.video.path);
    const metadataFile = path.join(projectPath, manifest.artifacts.metadata.path);
    const publicationId = crypto.randomUUID();
    const requestFile = path.join(projectPath, '06_publish', `publish_request_${publicationId}.json`);
    const resultFile = path.join(projectPath, '06_publish', `publication_result_${publicationId}.json`);
    const thumbnail = path.join(projectPath, manifest.artifacts.thumbnail.path);
    const payload = { video, metadataFile, privacy: 'private', publishAt: null, thumbnail, resultFile, releaseManifest: manifest };
    writeAtomic(requestFile, JSON.stringify(payload, null, 2));
    const python = path.join(PROJECT_ROOT, 'youtube-mcp', '.venv', 'bin', 'python');
    if (!fs.existsSync(python)) throw Object.assign(new Error('YouTube environment is not installed'), { statusCode: 503 });
    const commandSpec = { command: python, args: [path.join(PROJECT_ROOT, 'tools', 'chitra_youtube.py'), 'upload', '--request', requestFile], cwd: path.join(PROJECT_ROOT, 'youtube-mcp') };
    const run = jobs.enqueue({ project, stageId: 'publish', substage: 'upload', adapter: 'youtube', commandSpec, projectPath,
      inputHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
    store.createPublication({ id: publicationId, projectKey, runId: run.id, privacy: 'private', scheduledAt: null, payload });
    store.recordReleaseEvent({ projectKey, publicationId, actor: getSession(request)?.id || 'owner', action: 'private_candidate_queued', payload: { score: candidate.quality.score } });
    publicationByRun.set(run.id, publicationId);
    return sendJson(response, 202, { run, publicationId });
  }

  match = pathname.match(/^\/media\/([^/]+)\/(.+)$/);
  if (match && request.method === 'GET') {
    requireSession(request);
    const projectPath = projectPathForKey(assertProjectKey(match[1]));
    return serveMedia(request, response, resolveContained(projectPath, assertRelativePath(match[2]), { mustExist: true }));
  }

  if (pathname.startsWith('/api/')) throw Object.assign(new Error('API route not found'), { statusCode: 404 });
  // Workspace URLs are client-rendered, but must survive refreshes and be shareable.
  if (request.method === 'GET' && /^\/videos(?:\/.*)?$/i.test(pathname)) return serveStatic(response, '/');
  return serveStatic(response, pathname);
}

const server = http.createServer((request, response) => route(request, response).catch((error) => sendError(response, error)));
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (request, socket, head) => {
  try {
    if (new URL(request.url, `http://${request.headers.host}`).pathname !== '/ws') throw new Error('Not found');
    if (!requestOriginAllowed(request)) throw new Error('Origin not allowed');
    const session = getSession(request);
    const csrf = new URL(request.url, `http://${request.headers.host}`).searchParams.get('csrf');
    if (!session || !safeEqual(csrf, session.csrf)) throw new Error('Unauthorized');
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
});
wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: 'connected', serverTime: new Date().toISOString() }));
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }));
    } catch { socket.close(1003, 'Invalid message'); }
  });
  socket.on('close', () => sockets.delete(socket));
});

setInterval(() => {
  const stamp = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt < stamp) sessions.delete(id);
}, 60_000).unref();

function shutdown(signal) {
  console.log(`[Chitra Yantra] ${signal}; shutting down`);
  // Runs have their own process groups and durable log files. Do not turn a
  // server/browser reconnect into a cancellation; users can still stop a run
  // explicitly from the workspace.
  for (const socket of sockets) socket.close(1001, 'Server shutting down');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => {
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections?.();
    process.exit(1);
  }, 7000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => console.log(`[Chitra Yantra] http://${HOST}:${PORT}`));

module.exports = { server, store, jobs, scanChannels, syncArtifacts, projectPathForKey };
