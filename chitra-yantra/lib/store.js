'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { STAGES } = require('./stages');

function now() { return new Date().toISOString(); }
function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

class Store {
  constructor(databasePath, legacyStateDir) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
    this.importLegacy(legacyStateDir);
    // Do not classify a run as interrupted merely because this process opened
    // the database. A command is launched in its own process group and can
    // outlive a server restart; JobManager reconciles its saved PID after the
    // server is ready. Treating every live row as interrupted here made a
    // harmless browser/server reconnect look like a cancelled command.
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
        current_stage TEXT NOT NULL DEFAULT 'idea', settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(channel_id, slug)
      );
      CREATE TABLE IF NOT EXISTS stage_state (
        project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        stage_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'blocked', agent TEXT,
        auto_mode INTEGER NOT NULL DEFAULT 0, prompt_override TEXT, data_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, PRIMARY KEY(project_key, stage_id)
      );
      CREATE TABLE IF NOT EXISTS stage_runs (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        stage_id TEXT NOT NULL, substage TEXT NOT NULL, status TEXT NOT NULL, adapter TEXT NOT NULL,
        attempt INTEGER NOT NULL, input_hash TEXT NOT NULL, log_path TEXT NOT NULL, pid INTEGER,
        command_line TEXT, cwd TEXT, expected_outputs_json TEXT,
        started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, error TEXT, result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_project ON stage_runs(project_key, started_at DESC);
      CREATE TABLE IF NOT EXISTS artifact_revisions (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        stage_id TEXT NOT NULL, relative_path TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        provenance_json TEXT NOT NULL DEFAULT '{}', content_blob BLOB, created_at TEXT NOT NULL,
        UNIQUE(project_key, relative_path, revision)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        stage_id TEXT NOT NULL, artifact_revision_id TEXT, decision TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        run_id TEXT, platform TEXT NOT NULL DEFAULT 'youtube', status TEXT NOT NULL,
        remote_id TEXT, remote_url TEXT, privacy TEXT, scheduled_at TEXT, payload_json TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS script_versions (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, parent_id TEXT REFERENCES script_versions(id) ON DELETE SET NULL,
        language TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'draft', status TEXT NOT NULL DEFAULT 'draft',
        is_master INTEGER NOT NULL DEFAULT 0, audit_json TEXT NOT NULL DEFAULT '{}', selection_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_key, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_script_versions_project ON script_versions(project_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS script_comments (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, section_label TEXT NOT NULL DEFAULT '', quote_text TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_script_comments_version ON script_comments(script_version_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        mode TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, topic TEXT, proactive INTEGER NOT NULL DEFAULT 0,
        retry_json TEXT NOT NULL DEFAULT '{}', pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL, origin TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_project ON workflow_events(project_key, id);
      CREATE TABLE IF NOT EXISTS release_events (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
        publication_id TEXT REFERENCES publications(id) ON DELETE SET NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_release_events_project ON release_events(project_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', '1');
    `);
    const artifactColumns = this.db.prepare('PRAGMA table_info(artifact_revisions)').all();
    if (!artifactColumns.some((column) => column.name === 'content_blob')) {
      this.db.exec('ALTER TABLE artifact_revisions ADD COLUMN content_blob BLOB');
    }
    const runColumns = this.db.prepare('PRAGMA table_info(stage_runs)').all();
    if (!runColumns.some((column) => column.name === 'command_line')) {
      this.db.exec('ALTER TABLE stage_runs ADD COLUMN command_line TEXT');
    }
    if (!runColumns.some((column) => column.name === 'cwd')) {
      this.db.exec('ALTER TABLE stage_runs ADD COLUMN cwd TEXT');
    }
    if (!runColumns.some((column) => column.name === 'expected_outputs_json')) {
      this.db.exec('ALTER TABLE stage_runs ADD COLUMN expected_outputs_json TEXT');
    }
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', '5')").run();
  }

  importLegacy(stateDir) {
    if (!stateDir || !fs.existsSync(stateDir)) return;
    const imported = this.db.prepare("SELECT value FROM schema_meta WHERE key='legacy_imported'").get();
    if (imported) return;
    for (const file of fs.readdirSync(stateDir).filter((name) => name.endsWith('.json'))) {
      try {
        const legacy = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
        const projectKey = legacy.projectSlug || file.slice(0, -5);
        const split = projectKey.indexOf('__');
        if (split < 1) continue;
        const channelId = projectKey.slice(0, split);
        const slug = projectKey.slice(split + 2);
        this.ensureProject({ projectKey, channelId, slug, title: slug, currentStage: legacy.currentStage || 'idea' });
        for (const stage of STAGES) {
          const old = legacy.stages?.[stage.id] || {};
          const legacyStatus = {
            done: 'needs_review', error: 'failed', running: 'failed',
            pending: stage.id === 'idea' ? 'ready' : 'blocked',
          }[old.status];
          this.patchStage(projectKey, stage.id, {
            status: legacyStatus,
            agent: old.agent || null, autoMode: Boolean(old.autoMode), promptOverride: old.promptOverride || null,
            data: Object.fromEntries(Object.entries(old).filter(([key]) => !['status', 'agent', 'autoMode', 'promptOverride', 'artifacts'].includes(key))),
          });
        }
      } catch (error) {
        console.warn(`[store] Could not import ${file}: ${error.message}`);
      }
    }
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('legacy_imported', ?)").run(now());
  }

  ensureProject({ projectKey, channelId, slug, title, currentStage = 'idea', settings = {} }) {
    const stamp = now();
    this.db.prepare(`INSERT INTO projects(project_key, channel_id, slug, title, current_stage, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_key) DO UPDATE SET
        updated_at=CASE WHEN projects.title<>excluded.title THEN excluded.updated_at ELSE projects.updated_at END,
        title=excluded.title`
    ).run(projectKey, channelId, slug, title || slug, currentStage, JSON.stringify(settings), stamp, stamp);
    const insertStage = this.db.prepare(`INSERT OR IGNORE INTO stage_state(project_key, stage_id, status, updated_at) VALUES (?, ?, ?, ?)`);
    for (const [index, stage] of STAGES.entries()) insertStage.run(projectKey, stage.id, index === 0 ? 'ready' : 'blocked', stamp);
    return this.getProject(projectKey);
  }

  getProject(projectKey) {
    const project = this.db.prepare('SELECT * FROM projects WHERE project_key=?').get(projectKey);
    if (!project) return null;
    const stageRows = this.db.prepare('SELECT * FROM stage_state WHERE project_key=?').all(projectKey);
    const stages = Object.fromEntries(stageRows.map((row) => [row.stage_id, {
      status: row.status, agent: row.agent, autoMode: Boolean(row.auto_mode), promptOverride: row.prompt_override,
      data: json(row.data_json), updatedAt: row.updated_at,
    }]));
    return {
      projectKey: project.project_key, channelId: project.channel_id, slug: project.slug, title: project.title,
      currentStage: project.current_stage, settings: json(project.settings_json),
      createdAt: project.created_at, updatedAt: project.updated_at, stages,
    };
  }

  updateProject(projectKey, patch) {
    const current = this.getProject(projectKey);
    if (!current) return null;
    const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, 200) : current.title;
    const currentStage = patch.currentStage || current.currentStage;
    const settings = patch.settings ? { ...current.settings, ...patch.settings } : current.settings;
    this.db.prepare('UPDATE projects SET title=?, current_stage=?, settings_json=?, updated_at=? WHERE project_key=?')
      .run(title || current.title, currentStage, JSON.stringify(settings), now(), projectKey);
    return this.getProject(projectKey);
  }

  deleteProject(projectKey) {
    if (!projectKey || typeof projectKey !== 'string') return false;
    const project = this.getProject(projectKey);
    if (!project) return false;
    try {
      const runs = this.db.prepare('SELECT log_path FROM stage_runs WHERE project_key=?').all(projectKey);
      for (const run of runs) {
        if (run.log_path && fs.existsSync(run.log_path)) {
          try { fs.unlinkSync(run.log_path); } catch { /* ignore log cleanup error */ }
        }
      }
    } catch { /* ignore */ }
    this.db.prepare('DELETE FROM projects WHERE project_key=?').run(projectKey);
    return true;
  }

  moveProjectKey(projectKey, { newProjectKey, channelId }) {
    const current = this.getProject(projectKey);
    if (!current) return null;
    if (projectKey === newProjectKey) return current;
    if (this.getProject(newProjectKey)) throw Object.assign(new Error('A video with this dated workspace already exists in that channel'), { statusCode: 409 });
    const stamp = now();
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const table of ['stage_state', 'stage_runs', 'artifact_revisions', 'approvals', 'publications', 'script_versions', 'script_comments', 'workflows', 'workflow_events']) {
        this.db.prepare(`UPDATE ${table} SET project_key=? WHERE project_key=?`).run(newProjectKey, projectKey);
      }
      this.db.prepare('UPDATE projects SET project_key=?, channel_id=?, updated_at=? WHERE project_key=?')
        .run(newProjectKey, channelId, stamp, projectKey);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction was not started */ }
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON');
    }
    return this.getProject(newProjectKey);
  }

  patchStage(projectKey, stageId, patch) {
    const current = this.getProject(projectKey)?.stages?.[stageId];
    if (!current) return null;
    const status = patch.status || current.status;
    const agent = patch.agent === undefined ? current.agent : patch.agent;
    const autoMode = patch.autoMode === undefined ? current.autoMode : Boolean(patch.autoMode);
    const promptOverride = patch.promptOverride === undefined ? current.promptOverride : patch.promptOverride;
    const data = patch.data ? { ...current.data, ...patch.data } : current.data;
    this.db.prepare(`UPDATE stage_state SET status=?, agent=?, auto_mode=?, prompt_override=?, data_json=?, updated_at=?
      WHERE project_key=? AND stage_id=?`).run(status, agent, autoMode ? 1 : 0, promptOverride, JSON.stringify(data), now(), projectKey, stageId);
    return this.getProject(projectKey).stages[stageId];
  }

  createRun({ id, projectKey, stageId, substage, adapter, inputHash, logPath, commandLine = '', cwd = '', expectedOutputs = [] }) {
    const previous = this.db.prepare('SELECT MAX(attempt) AS attempt FROM stage_runs WHERE project_key=? AND stage_id=? AND substage=?')
      .get(projectKey, stageId, substage);
    const attempt = Number(previous?.attempt || 0) + 1;
    this.db.prepare(`INSERT INTO stage_runs(id,project_key,stage_id,substage,status,adapter,attempt,input_hash,log_path,command_line,cwd,expected_outputs_json,started_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectKey, stageId, substage, 'queued', adapter, attempt, inputHash, logPath, commandLine, cwd, JSON.stringify(expectedOutputs), now());
    return this.getRun(id);
  }

  startRun(id, pid) { this.db.prepare("UPDATE stage_runs SET status='running', pid=? WHERE id=?").run(pid, id); }
  finishRun(id, { status, exitCode = null, error = null, result = null }) {
    this.db.prepare('UPDATE stage_runs SET status=?, finished_at=?, exit_code=?, error=?, result_json=? WHERE id=?')
      .run(status, now(), exitCode, error, result ? JSON.stringify(result) : null, id);
  }
  getRun(id) { return this.formatRun(this.db.prepare('SELECT * FROM stage_runs WHERE id=?').get(id)); }
  listRuns(projectKey, limit = 50) {
    return this.db.prepare('SELECT * FROM stage_runs WHERE project_key=? ORDER BY started_at DESC LIMIT ?').all(projectKey, limit).map((row) => this.formatRun(row));
  }
  listActiveRuns() {
    return this.db.prepare("SELECT * FROM stage_runs WHERE status IN ('queued','running') ORDER BY started_at ASC").all().map((row) => this.formatRun(row));
  }
  formatRun(row) {
    if (!row) return null;
    return { id: row.id, projectKey: row.project_key, stageId: row.stage_id, substage: row.substage,
      status: row.status, adapter: row.adapter, attempt: row.attempt, inputHash: row.input_hash,
      logPath: row.log_path, commandLine: row.command_line || '', cwd: row.cwd || '', expectedOutputs: json(row.expected_outputs_json, null), pid: row.pid,
      startedAt: row.started_at, finishedAt: row.finished_at,
      exitCode: row.exit_code, error: row.error, result: json(row.result_json, null) };
  }

  recordArtifact({ projectKey, stageId, relativePath, content, mimeType, provenance = {}, status = 'draft' }) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const restorable = buffer.length <= 1024 * 1024 && (mimeType.startsWith('text/') || mimeType.startsWith('application/json') || mimeType.startsWith('application/x-subrip'));
    const latest = this.db.prepare('SELECT MAX(revision) AS revision FROM artifact_revisions WHERE project_key=? AND relative_path=?').get(projectKey, relativePath);
    const revision = Number(latest?.revision || 0) + 1;
    const record = { id: crypto.randomUUID(), revision, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
    this.db.prepare(`INSERT INTO artifact_revisions(id,project_key,stage_id,relative_path,revision,sha256,mime_type,size,status,provenance_json,content_blob,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, projectKey, stageId, relativePath, revision, record.sha256, mimeType, record.size, status, JSON.stringify(provenance), restorable ? buffer : null, now());
    return record;
  }

  hydrateArtifactContent(id, content, mimeType) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (buffer.length > 1024 * 1024 || !(mimeType.startsWith('text/') || mimeType.startsWith('application/json') || mimeType.startsWith('application/x-subrip'))) return;
    this.db.prepare('UPDATE artifact_revisions SET content_blob=COALESCE(content_blob, ?) WHERE id=?').run(buffer, id);
  }

  markArtifactObserved(id, mtimeMs) {
    const row = this.db.prepare('SELECT provenance_json FROM artifact_revisions WHERE id=?').get(id);
    if (!row) return;
    this.db.prepare('UPDATE artifact_revisions SET provenance_json=? WHERE id=?')
      .run(JSON.stringify({ ...json(row.provenance_json), mtimeMs }), id);
  }

  listArtifactRevisions(projectKey, relativePath) {
    return this.db.prepare(`SELECT id,stage_id,relative_path,revision,sha256,mime_type,size,status,provenance_json,created_at,
      content_blob IS NOT NULL AS restorable FROM artifact_revisions WHERE project_key=? AND relative_path=? ORDER BY revision DESC`)
      .all(projectKey, relativePath).map((row) => ({
        id: row.id, stageId: row.stage_id, relativePath: row.relative_path, revision: row.revision,
        sha256: row.sha256, mimeType: row.mime_type, size: row.size, status: row.status,
        provenance: json(row.provenance_json), createdAt: row.created_at, restorable: Boolean(row.restorable),
      }));
  }

  getArtifactRevision(projectKey, id) {
    const row = this.db.prepare('SELECT * FROM artifact_revisions WHERE project_key=? AND id=?').get(projectKey, id);
    if (!row) return null;
    return {
      id: row.id, stageId: row.stage_id, relativePath: row.relative_path, revision: row.revision,
      mimeType: row.mime_type, content: row.content_blob === null ? null : Buffer.from(row.content_blob),
    };
  }

  listArtifacts(projectKey, stageId = null) {
    const sql = `SELECT a.* FROM artifact_revisions a JOIN (
      SELECT relative_path, MAX(revision) revision FROM artifact_revisions WHERE project_key=? GROUP BY relative_path
    ) latest ON latest.relative_path=a.relative_path AND latest.revision=a.revision
    WHERE a.project_key=? ${stageId ? 'AND a.stage_id=?' : ''} ORDER BY a.relative_path`;
    const rows = stageId ? this.db.prepare(sql).all(projectKey, projectKey, stageId) : this.db.prepare(sql).all(projectKey, projectKey);
    return rows.map((row) => ({ id: row.id, stageId: row.stage_id, relativePath: row.relative_path, revision: row.revision,
      sha256: row.sha256, mimeType: row.mime_type, size: row.size, status: row.status,
      provenance: json(row.provenance_json), createdAt: row.created_at }));
  }

  upsertScriptVersion({ projectKey, relativePath, parentId = null, language = 'hi', kind = 'draft', status = 'draft', audit = {} }) {
    const existing = this.db.prepare('SELECT * FROM script_versions WHERE project_key=? AND relative_path=?').get(projectKey, relativePath);
    const stamp = now();
    if (existing) {
      this.db.prepare("UPDATE script_versions SET parent_id=COALESCE(?, parent_id), language=?, kind=?, status=CASE WHEN status='selected' THEN status ELSE ? END, audit_json=CASE WHEN audit_json='{}' THEN ? ELSE audit_json END, updated_at=? WHERE id=?")
        .run(parentId, language, kind, status, JSON.stringify(audit), stamp, existing.id);
      return this.getScriptVersion(projectKey, existing.id);
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO script_versions(id,project_key,relative_path,parent_id,language,kind,status,audit_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, projectKey, relativePath, parentId, language, kind, status, JSON.stringify(audit), stamp, stamp);
    return this.getScriptVersion(projectKey, id);
  }

  getScriptVersion(projectKey, id) {
    const row = this.db.prepare('SELECT * FROM script_versions WHERE project_key=? AND id=?').get(projectKey, id);
    return row ? this.formatScriptVersion(row) : null;
  }

  listScriptVersions(projectKey) {
    return this.db.prepare('SELECT * FROM script_versions WHERE project_key=? ORDER BY created_at DESC').all(projectKey).map((row) => this.formatScriptVersion(row));
  }

  formatScriptVersion(row) {
    return { id: row.id, projectKey: row.project_key, relativePath: row.relative_path, parentId: row.parent_id,
      language: row.language, kind: row.kind, status: row.status, isMaster: Boolean(row.is_master),
      audit: json(row.audit_json), selectionNote: row.selection_note, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  updateScriptVersion(projectKey, id, patch = {}) {
    const current = this.getScriptVersion(projectKey, id);
    if (!current) return null;
    const status = patch.status || current.status;
    const audit = patch.audit === undefined ? current.audit : patch.audit;
    const note = patch.selectionNote === undefined ? current.selectionNote : String(patch.selectionNote || '').slice(0, 2000);
    this.db.prepare('UPDATE script_versions SET status=?, audit_json=?, selection_note=?, updated_at=? WHERE id=? AND project_key=?')
      .run(status, JSON.stringify(audit), note, now(), id, projectKey);
    return this.getScriptVersion(projectKey, id);
  }

  selectMasterScript(projectKey, id, selectionNote = '') {
    const selected = this.getScriptVersion(projectKey, id);
    if (!selected) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE script_versions SET is_master=0, updated_at=? WHERE project_key=?').run(now(), projectKey);
      this.db.prepare("UPDATE script_versions SET is_master=1, status='selected', selection_note=?, updated_at=? WHERE id=? AND project_key=?")
        .run(String(selectionNote || '').slice(0, 2000), now(), id, projectKey);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getScriptVersion(projectKey, id);
  }

  addScriptComment({ projectKey, scriptVersionId, scope = 'text', sectionLabel = '', quoteText = '', body }) {
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO script_comments(id,project_key,script_version_id,scope,section_label,quote_text,body,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, projectKey, scriptVersionId, scope, String(sectionLabel).slice(0, 300), String(quoteText).slice(0, 2000), String(body).slice(0, 8000), 'open', now());
    return this.getScriptComment(projectKey, id);
  }

  getScriptComment(projectKey, id) {
    const row = this.db.prepare('SELECT * FROM script_comments WHERE project_key=? AND id=?').get(projectKey, id);
    return row ? { id: row.id, scriptVersionId: row.script_version_id, scope: row.scope, sectionLabel: row.section_label,
      quoteText: row.quote_text, body: row.body, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at } : null;
  }

  listScriptComments(projectKey, scriptVersionId = null) {
    const sql = `SELECT * FROM script_comments WHERE project_key=? ${scriptVersionId ? 'AND script_version_id=?' : ''} ORDER BY created_at DESC`;
    const rows = scriptVersionId ? this.db.prepare(sql).all(projectKey, scriptVersionId) : this.db.prepare(sql).all(projectKey);
    return rows.map((row) => ({ id: row.id, scriptVersionId: row.script_version_id, scope: row.scope, sectionLabel: row.section_label,
      quoteText: row.quote_text, body: row.body, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at }));
  }

  resolveScriptComment(projectKey, id) {
    this.db.prepare("UPDATE script_comments SET status='resolved', resolved_at=? WHERE id=? AND project_key=?").run(now(), id, projectKey);
    return this.getScriptComment(projectKey, id);
  }

  createWorkflow({ projectKey, mode, origin = 'gui', topic = null, proactive = false }) {
    const stamp = now();
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO workflows(id,project_key,mode,origin,status,topic,proactive,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, projectKey, mode, origin, 'running', topic, proactive ? 1 : 0, stamp, stamp);
    return this.getWorkflow(projectKey, id);
  }

  getWorkflow(projectKey, id) {
    const row = this.db.prepare('SELECT * FROM workflows WHERE project_key=? AND id=?').get(projectKey, id);
    return row ? this.formatWorkflow(row) : null;
  }

  latestWorkflow(projectKey) {
    const row = this.db.prepare('SELECT * FROM workflows WHERE project_key=? ORDER BY created_at DESC LIMIT 1').get(projectKey);
    return row ? this.formatWorkflow(row) : null;
  }

  patchWorkflow(projectKey, id, patch = {}) {
    const current = this.getWorkflow(projectKey, id);
    if (!current) return null;
    const status = patch.status || current.status;
    const retries = patch.retries === undefined ? current.retries : patch.retries;
    const pauseReason = patch.pauseReason === undefined ? current.pauseReason : patch.pauseReason;
    this.db.prepare('UPDATE workflows SET status=?, retry_json=?, pause_reason=?, updated_at=? WHERE id=? AND project_key=?')
      .run(status, JSON.stringify(retries || {}), pauseReason || null, now(), id, projectKey);
    return this.getWorkflow(projectKey, id);
  }

  formatWorkflow(row) {
    return { id: row.id, projectKey: row.project_key, mode: row.mode, origin: row.origin, status: row.status,
      topic: row.topic, proactive: Boolean(row.proactive), retries: json(row.retry_json), pauseReason: row.pause_reason,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  recordWorkflowEvent({ projectKey, workflowId = null, origin = 'system', type, payload = {} }) {
    const result = this.db.prepare('INSERT INTO workflow_events(project_key,workflow_id,origin,type,payload_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(projectKey, workflowId, origin, type, JSON.stringify(payload), now());
    return this.getWorkflowEvent(Number(result.lastInsertRowid));
  }

  getWorkflowEvent(id) {
    const row = this.db.prepare('SELECT * FROM workflow_events WHERE id=?').get(id);
    return row ? this.formatWorkflowEvent(row) : null;
  }

  listWorkflowEvents(projectKey, afterId = 0, limit = 200) {
    return this.db.prepare('SELECT * FROM workflow_events WHERE project_key=? AND id>? ORDER BY id ASC LIMIT ?')
      .all(projectKey, Number(afterId) || 0, Math.min(500, Math.max(1, Number(limit) || 200))).map((row) => this.formatWorkflowEvent(row));
  }

  formatWorkflowEvent(row) {
    return { id: row.id, projectKey: row.project_key, workflowId: row.workflow_id, origin: row.origin,
      type: row.type, payload: json(row.payload_json), createdAt: row.created_at };
  }

  approve({ projectKey, stageId, artifactRevisionId = null, decision, note = '' }) {
    this.db.prepare('INSERT INTO approvals(id,project_key,stage_id,artifact_revision_id,decision,note,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), projectKey, stageId, artifactRevisionId, decision, note.slice(0, 2000), now());
    this.patchStage(projectKey, stageId, { status: decision === 'approved' ? 'approved' : 'needs_review' });
    if (decision === 'approved') this.unlockDependents(projectKey);
    return this.getProject(projectKey);
  }

  unlockDependents(projectKey) {
    const project = this.getProject(projectKey);
    for (const stage of STAGES) {
      if (project.stages[stage.id].status !== 'blocked') continue;
      if (stage.requires.every((required) => project.stages[required]?.status === 'approved')) {
        this.patchStage(projectKey, stage.id, { status: 'ready' });
      }
    }
  }

  createPublication({ id, projectKey, runId, privacy, scheduledAt, payload }) {
    const stamp = now();
    this.db.prepare(`INSERT INTO publications(id,project_key,run_id,status,privacy,scheduled_at,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, projectKey, runId, 'uploading', privacy, scheduledAt, JSON.stringify(payload), stamp, stamp);
  }
  finishPublication(id, { status, remoteId = null, remoteUrl = null, error = null }) {
    this.db.prepare('UPDATE publications SET status=?, remote_id=?, remote_url=?, error=?, updated_at=? WHERE id=?')
      .run(status, remoteId, remoteUrl, error, now(), id);
  }
  listPublications(projectKey) {
    return this.db.prepare('SELECT * FROM publications WHERE project_key=? ORDER BY created_at DESC').all(projectKey).map((row) => ({
      id: row.id, runId: row.run_id, status: row.status, remoteId: row.remote_id, remoteUrl: row.remote_url,
      privacy: row.privacy, scheduledAt: row.scheduled_at, payload: json(row.payload_json), error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
  recordReleaseEvent({ projectKey, publicationId = null, actor, action, rationale = '', payload = {} }) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO release_events(id,project_key,publication_id,actor,action,rationale,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, projectKey, publicationId, String(actor || 'owner').slice(0, 120), String(action).slice(0, 80), String(rationale).slice(0, 4000), JSON.stringify(payload), now());
    return { id, projectKey, publicationId, actor, action, rationale, payload, createdAt: now() };
  }
  listReleaseEvents(projectKey) {
    return this.db.prepare('SELECT * FROM release_events WHERE project_key=? ORDER BY created_at DESC').all(projectKey).map((row) => ({
      id: row.id, projectKey: row.project_key, publicationId: row.publication_id, actor: row.actor, action: row.action,
      rationale: row.rationale, payload: json(row.payload_json), createdAt: row.created_at,
    }));
  }
}

module.exports = { Store };
