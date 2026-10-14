# Chitra MCP

Local stdio MCP bridge for Chitra Yantra. Start Chitra Yantra first, then install this
package into an environment that already has `mcp`:

```bash
youtube-mcp/.venv/bin/pip install -e chitra-mcp
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "chitra-yantra": {
      "command": "/path/to/youtube-mcp/.venv/bin/chitra-mcp"
    }
  }
}
```

The bridge talks only to `http://127.0.0.1:7842/api/agent/v1` by default. Override
that location with `CHITRA_AGENT_URL` when using another local port.

Use `chitra_start_research` to launch the adaptive research pipeline directly for an
idea-approved workspace. Global automation invokes the same pipeline automatically.
The returned job is asynchronous; monitor all planner, angle, synthesis, and verifier
runs with `chitra_workspace_status` or `chitra_workspace_events`.
