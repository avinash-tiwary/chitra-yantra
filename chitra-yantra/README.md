# Chitra Yantra

The authoritative channel-project filesystem contract is documented in
[`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md). Existing workspaces can be migrated
non-destructively with `python tools/migrate_chitra_schema.py --apply`.

Local-first production control room for the complete video workflow: idea, research, script, asset plan, audio, visuals, assembly, QC, package, and verified YouTube upload.

## Audio production

Audio is a local, revisioned production stage. The Editorial Blueprint derives
`03_audio/plans/audio_plan_v{n}.json`; that plan tracks cloned narration,
music, generated/imported ambience and effects, cue timing, mix settings and
timestamped revision comments. Raw takes are retained, while review and final
masters are separate artifacts. A final approval is required before delivery
WAV/AAC assets are used downstream.

The application never opens ComfyUI or a model browser. Local provider
preflight is available through `tools/audio_production.py`; ACE-Step has a
direct local source integration, while YuE deliberately remains unavailable
until its direct runner has been provisioned and smoke-tested. It never falls
back to a ComfyUI workflow.

## Install and run

Requirements: Node.js 22.5+, Python 3.10+, FFmpeg/FFprobe, and at least one supported agent CLI.
Hyperframe 6.1.0 is installed in the repository virtual environment for video production.

```bash
cd /path/to/youtube
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 -m venv youtube-mcp/.venv
youtube-mcp/.venv/bin/pip install -e 'youtube-mcp[dev]'
youtube-mcp/.venv/bin/pip install -e chitra-mcp
cd chitra-yantra && npm ci
npm run preflight && npm test && npm start
```

Open `http://127.0.0.1:7842`. The server intentionally binds only to loopback. Remote binding requires `CHITRA_ALLOW_REMOTE=1` and an authenticated TLS reverse proxy; Chitra Yantra itself is a single-user local application.

Copy `config/.env.example` to `config/.env` for the Anthropic adapter. YouTube OAuth files belong in `youtube-mcp/.secrets/`; both locations are ignored by Git.

## Data and recovery

- Project artifacts live under `channels/<channel>/videos/<project>/` in the numbered `00_project`–`06_publish` schema.
- Durable workflow state, run history, approvals, and text revision snapshots live in `chitra-yantra/data/chitra.db` using SQLite WAL mode.
- Interrupted jobs and uploads are marked `interrupted`/`failed` during restart; they are never silently resumed.
- Text artifacts can be restored from the revision selector. Restoration creates another revision, so it is reversible.
- Legacy folders can be copied safely with `python tools/migrate_chitra_schema.py --channel <id> --apply`. Conflicts go to `99_archive`; sources are not deleted.

For backup, stop the server and copy both `channels/` and `chitra-yantra/data/chitra.db`. Store `config/.env` and `youtube-mcp/.secrets/` separately in an encrypted secret backup. Restore those paths while the server is stopped, then run `npm run preflight` before restart.

## Release safety

Every downstream stage is locked until its dependencies are approved. Approval validates required files, source links, visual provenance/rights, media outputs, QC checks, and YouTube metadata limits. Publishing additionally requires an authenticated channel, the exact project title, a valid future schedule when supplied, and a successful API response before the stage becomes approved. Uploads default to private.

## Operations

- Health: `GET /api/health`
- Concurrency: `CHITRA_MAX_JOBS=1..10` (default `4`)
- Bind address: `CHITRA_HOST` (default `127.0.0.1`)
- Port: `PORT` (default `7842`)
- Logs: `chitra-yantra/data/logs/`, capped at 10 MB per run

## Automation and agents

Workspaces support Global Auto (topic-led or proactive) and independent per-stage
Auto toggles. The scheduler validates and approves automated stages, runs independent
ready stages concurrently within `CHITRA_MAX_JOBS`, retries a failed substage once,
and then pauses with a durable diagnostic. A global workflow uploads to YouTube with
`private` visibility after all production gates pass.

Headless callers can use the loopback-only REST API at `/api/agent/v1`; it deliberately
does not accept browser cookies or expose access through remote bindings. The separate
`chitra-mcp` stdio server wraps that API for Codex and Claude Code. Its tools create and
start workspaces, monitor event streams, inspect artifacts/runs, and resume, pause, or
cancel automation. See [`../chitra-mcp/README.md`](../chitra-mcp/README.md) for config.

Research uses an adaptive fan-out/fan-in workflow shared by the browser, REST API,
MCP, and global automation. A planning agent chooses 3–10 topic-specific angles and
1–3 synthesis passes within workspace limits. Angle agents run as independent jobs;
their cited reports are retained under `01_research/passes/`. The final synthesis
produces an evidence dossier and coverage ledger, then a mandatory verifier produces
the claim ledger and script-safe production brief. Research jobs have explicit
20-minute planning, 45-minute investigation, and 30-minute synthesis/verification
limits. Sources are inspected on the web and cited directly; this workflow does not
download a local research corpus.

The browser session uses an HttpOnly same-site cookie, per-session CSRF token, strict same-origin checks, authenticated WebSockets, a restrictive CSP, and realpath containment for all project reads and writes.
