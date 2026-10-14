# YouTube MCP

Optional local MCP server for YouTube upload and analytics operations. It does not include a channel, OAuth client, refresh token, analytics export, or upload history.

Install it into an isolated environment:

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

Place your own OAuth client file and generated token in `.secrets/`, or set `YOUTUBE_CLIENT_SECRET_PATH` and `YOUTUBE_TOKEN_PATH`. These paths are excluded from Git. Run `youtube-mcp --auth` to authorize your own account.

The server is intended for local use. Review the requested Google OAuth scopes before granting access. Upload operations default to private visibility.

MIT licensed; see [LICENSE](LICENSE).
