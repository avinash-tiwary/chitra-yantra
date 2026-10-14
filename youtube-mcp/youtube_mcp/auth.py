"""
Authentication and token management for YouTube Data & Analytics APIs.
Provides secure token resolution, automatic silent refresh, and one-time interactive OAuth setup.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

# OAuth 2.0 Scopes required for complete channel studio & analytics operations
YOUTUBE_SCOPES: list[str] = [
    "https://www.googleapis.com/auth/youtube.upload",  # Video upload
    "https://www.googleapis.com/auth/youtube",  # Metadata, thumbnails, playlists
    "https://www.googleapis.com/auth/yt-analytics.readonly",  # Performance metrics & retention
]

DEFAULT_CONFIG_DIR = Path.home() / ".config" / "youtube-mcp"


class AuthError(Exception):
    """Base exception for authentication and credential resolution failures."""


class CredentialsMissingError(AuthError):
    """Raised when client_secret.json cannot be found on the filesystem."""


class TokenMissingError(AuthError):
    """Raised when token.json is absent and interactive authorization is required."""


def resolve_client_secret_path() -> Path:
    """
    Resolves the path to the Google Cloud OAuth client secret JSON file.
    Checks environment variable `YOUTUBE_CLIENT_SECRET_PATH` first, then common local paths.
    """
    env_path = os.getenv("YOUTUBE_CLIENT_SECRET_PATH")
    candidate_paths: list[Path] = []

    if env_path:
        candidate_paths.append(Path(env_path).expanduser().resolve())

    candidate_paths.extend(
        [
            Path("client_secret.json").resolve(),
            Path(".secrets/client_secret.json").resolve(),
            DEFAULT_CONFIG_DIR / "client_secret.json",
            Path("../client_secret.json").resolve(),
        ]
    )

    for path in candidate_paths:
        if path.is_file():
            return path

    raise CredentialsMissingError(
        "Google OAuth client_secret.json was not found.\n"
        "Searched locations:\n"
        + "\n".join(f" - {p}" for p in candidate_paths)
        + "\n\nPlease download your OAuth 2.0 Client ID (Desktop App) from Google Cloud Console "
        "and save it as 'client_secret.json' or set the YOUTUBE_CLIENT_SECRET_PATH environment variable."
    )


def resolve_token_path() -> Path:
    """
    Resolves the destination path for saving and loading the OAuth 2.0 refresh token.
    Checks `YOUTUBE_TOKEN_PATH`, then local and user config paths.
    """
    env_path = os.getenv("YOUTUBE_TOKEN_PATH")
    if env_path:
        return Path(env_path).expanduser().resolve()

    # If a token exists in standard locations, return that
    candidates = [
        Path("token.json").resolve(),
        Path(".secrets/token.json").resolve(),
        DEFAULT_CONFIG_DIR / "token.json",
    ]
    for p in candidates:
        if p.is_file():
            return p

    # Default fallback destination for new tokens
    return Path("token.json").resolve()


def save_token_securely(creds: Credentials, token_path: Path) -> None:
    """
    Saves user credentials to disk with restricted file permissions (owner-only read/write).
    """
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")

    # Restrict permissions on POSIX systems (chmod 600: read/write by owner only)
    if os.name == "posix":
        try:
            os.chmod(token_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass


def get_credentials(interactive_if_missing: bool = False) -> Credentials:
    """
    Retrieves valid Google OAuth 2.0 credentials.
    - If valid token exists on disk: returns credentials.
    - If token is expired and has refresh token: refreshes silently.
    - If token is missing:
        - If interactive_if_missing is True: launches local OAuth consent flow.
        - If False: raises TokenMissingError with explicit setup instructions.
    """
    token_path = resolve_token_path()
    creds: Credentials | None = None

    if token_path.is_file():
        try:
            creds = Credentials.from_authorized_user_file(str(token_path), YOUTUBE_SCOPES)
        except Exception:
            creds = None

    # Refresh token if expired
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            save_token_securely(creds, token_path)
            return creds
        except Exception:
            creds = None

    # Valid active token
    if creds and creds.valid:
        return creds

    # Interactive flow required
    if not interactive_if_missing:
        raise TokenMissingError(
            f"No valid YouTube OAuth token found at '{token_path}'.\n"
            "An initial one-time authorization is required.\n"
            "Please run the one-time authentication command in your terminal:\n\n"
            "    python -m youtube_mcp.auth\n"
            "    or: youtube-mcp --auth\n\n"
            "This will open a browser window to grant permissions and save the refresh token."
        )

    # Execute interactive flow
    secret_path = resolve_client_secret_path()
    port = int(os.getenv("YOUTUBE_AUTH_PORT", "0"))

    flow = InstalledAppFlow.from_client_secrets_file(str(secret_path), YOUTUBE_SCOPES)
    creds = flow.run_local_server(
        port=port,
        prompt="select_account consent",
        access_type="offline",
        success_message="Authorization complete! You can close this browser tab and return to the terminal.",
    )

    save_token_securely(creds, token_path)
    return creds


if __name__ == "__main__":
    # Interactive CLI auth entrypoint: python -m youtube_mcp.auth
    import sys

    from rich.console import Console

    console = Console()

    console.print("[bold cyan]YouTube MCP - Authentication Setup[/bold cyan]")
    try:
        secret_file = resolve_client_secret_path()
        console.print(f"[green]Found client secret at:[/green] {secret_file}")
        console.print("[yellow]Starting one-time OAuth browser authorization flow...[/yellow]")
        credentials = get_credentials(interactive_if_missing=True)
        console.print(
            f"[bold green]Authentication successful![/bold green] Token saved to: {resolve_token_path()}"
        )
    except Exception as e:
        console.print(f"[bold red]Authentication failed:[/bold red] {e}")
        sys.exit(1)
