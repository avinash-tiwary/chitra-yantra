"""
Tests for auth resolution and error states.
"""

import pytest

from youtube_mcp.auth import (
    CredentialsMissingError,
    TokenMissingError,
    get_credentials,
    resolve_client_secret_path,
)


def test_missing_client_secret(monkeypatch, tmp_path):
    """Ensures a clean CredentialsMissingError is raised when no secret exists."""
    monkeypatch.setenv("YOUTUBE_CLIENT_SECRET_PATH", str(tmp_path / "non_existent_secret.json"))
    monkeypatch.chdir(tmp_path)

    with pytest.raises(CredentialsMissingError):
        resolve_client_secret_path()


def test_missing_token_non_interactive(monkeypatch, tmp_path):
    """Ensures TokenMissingError is raised in headless mode when no token.json exists."""
    monkeypatch.setenv("YOUTUBE_TOKEN_PATH", str(tmp_path / "non_existent_token.json"))
    monkeypatch.chdir(tmp_path)

    with pytest.raises(TokenMissingError):
        get_credentials(interactive_if_missing=False)
