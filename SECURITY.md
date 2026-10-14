# Security and privacy

Chitra Yantra is designed for a single local user. It binds to loopback by default, uses same-origin checks, CSRF tokens, authenticated WebSockets, and realpath containment for workspace access.

Do not expose the application directly to the internet. If remote access is required, set `CHITRA_ALLOW_REMOTE=1` only behind an authenticated TLS reverse proxy.

Never commit credentials, OAuth client files, refresh tokens, `.env` files, workspaces, generated media, model weights, or local databases. The repository `.gitignore` excludes these paths, but review staged files before every push.

To report a vulnerability, open a private security advisory in the repository. Do not include credentials, private video links, or personal data in the report.
