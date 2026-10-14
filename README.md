# Chitra Yantra

Chitra Yantra is a local-first control room for the end-to-end YouTube video-production workflow: idea, research, script, asset plan, audio, visuals, assembly, QC, packaging, and optional verified YouTube upload.

This repository deliberately contains code and empty workspace directories only. It contains no credentials, OAuth tokens, channel metadata, video projects, research, media, model weights, runtime databases, or editor settings.

## Quick start

Requirements: Node.js 22.5+, Python 3.10+, FFmpeg/FFprobe, and optionally a supported agent CLI.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 -m venv youtube-mcp/.venv
youtube-mcp/.venv/bin/pip install -e 'youtube-mcp[dev]'
youtube-mcp/.venv/bin/pip install -e chitra-mcp
cd chitra-yantra
npm ci
npm run preflight
npm test
npm start
```

Open <http://127.0.0.1:7842>. The server listens only on loopback by default. Copy `config/.env.example` to `config/.env` only if you want to enable an API-backed adapter; never commit that file.

Create a channel workspace in the app before creating a project. All workspace material is written under `channels/` and is ignored by Git by design.

## Repository layout

- `chitra-yantra/` — local web application and Node.js tests.
- `tools/` — optional Python production utilities.
- `youtube-mcp/` — optional YouTube upload and analytics MCP server.
- `chitra-mcp/` — local MCP bridge for Chitra Yantra.
- `channels/` — deliberately empty, local-only workspace root.

## Privacy and security

Credentials belong in `config/.env` and `youtube-mcp/.secrets/`; both are ignored. OAuth uploads default to private. See [SECURITY.md](SECURITY.md) for reporting guidance and the operating model.

## License

MIT. See [LICENSE](LICENSE).
