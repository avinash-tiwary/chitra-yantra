'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const checks = [];

function commandCheck(name, command, args = ['--version'], required = true) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
  checks.push({ name, required, ok: result.status === 0, detail: result.status === 0 ? (result.stdout || result.stderr).trim().split('\n')[0] : result.error?.message || result.stderr.trim() || 'not available' });
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
checks.push({
  name: 'Node.js 22.5+',
  required: true,
  ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5),
  detail: `v${process.versions.node}`,
});
commandCheck('FFmpeg', 'ffmpeg', ['-version']);
commandCheck('FFprobe', 'ffprobe', ['-version']);
commandCheck('Codex CLI', 'codex', ['--version'], false);
commandCheck('Claude CLI', 'claude', ['--version'], false);
commandCheck('Antigravity CLI', 'agy', ['--version'], false);

function pythonImports(label, candidates, modules) {
  const python = candidates.find((candidate) => candidate === 'python3' || fs.existsSync(candidate));
  const imports = spawnSync(python, ['-c', [
    'import importlib.util,json',
    `mods=${JSON.stringify(modules)}`,
    'print(json.dumps({m: bool(importlib.util.find_spec(m)) for m in mods}))',
  ].join(';')], { encoding: 'utf8', timeout: 10000 });
  if (imports.status !== 0) {
    checks.push({ name: `${label} Python environment`, required: true, ok: false, detail: imports.stderr.trim() || 'unavailable' });
    return;
  }
  const installed = JSON.parse(imports.stdout);
  for (const [name, ok] of Object.entries(installed)) checks.push({ name: `${label}: ${name}`, required: true, ok, detail: ok ? 'installed' : 'missing' });
}

pythonImports('Pipeline Python', [path.join(root, '.venv', 'bin', 'python'), 'python3'], ['anthropic', 'dotenv', 'requests', 'rich', 'ddgs', 'wikipediaapi', 'bs4', 'pydantic', 'tenacity']);
pythonImports('YouTube Python', [path.join(root, 'youtube-mcp', '.venv', 'bin', 'python'), 'python3'], ['googleapiclient', 'google_auth_oauthlib', 'mcp']);

for (const relative of ['channels', 'tools', 'chitra-yantra/prompts', 'youtube-mcp/youtube_mcp']) {
  checks.push({ name: relative, required: true, ok: fs.existsSync(path.join(root, relative)), detail: fs.existsSync(path.join(root, relative)) ? 'present' : 'missing' });
}

const failures = checks.filter((check) => check.required && !check.ok);
for (const check of checks) console.log(`${check.ok ? 'PASS' : check.required ? 'FAIL' : 'WARN'}  ${check.name} — ${check.detail}`);
console.log(`\n${checks.length - failures.length}/${checks.length} checks ready; ${failures.length} required failure(s).`);
process.exitCode = failures.length ? 1 : 0;
