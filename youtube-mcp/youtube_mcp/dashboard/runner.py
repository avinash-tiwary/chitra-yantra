"""
Server runner for the YouTube Creator Dashboard.
Supports running in foreground via CLI or background daemon thread via MCP tool.
"""

from __future__ import annotations

import threading
import time
import webbrowser

import uvicorn
from rich.console import Console

_server_thread: threading.Thread | None = None
_running_port: int | None = None


def run_dashboard(host: str = "127.0.0.1", port: int = 8501, auto_open: bool = True) -> None:
    """Runs the dashboard web server in the current process (blocking)."""
    console = Console()
    url = f"http://{host}:{port}"
    console.print("[bold cyan]YouTube Creator Studio & Analytics Dashboard[/bold cyan]")
    console.print(f"[green]Serving at:[/green] [bold underline]{url}[/bold underline]")

    if auto_open:

        def _open():
            time.sleep(0.8)
            webbrowser.open(url)

        threading.Thread(target=_open, daemon=True).start()

    uvicorn.run("youtube_mcp.dashboard.app:app", host=host, port=port, log_level="warning")


def launch_dashboard_in_background(host: str = "127.0.0.1", port: int = 8501, auto_open: bool = True) -> str:
    """
    Launches the dashboard web server in a background daemon thread.
    Returns the URL where the dashboard is accessible.
    """
    global _server_thread, _running_port

    url = f"http://{host}:{port}"

    if _server_thread and _server_thread.is_alive():
        if auto_open:
            webbrowser.open(url)
        return f"Dashboard is already active at: {url}"

    _running_port = port

    def _serve():
        config = uvicorn.Config("youtube_mcp.dashboard.app:app", host=host, port=port, log_level="warning")
        server = uvicorn.Server(config)
        server.run()

    _server_thread = threading.Thread(target=_serve, daemon=True)
    _server_thread.start()

    # Wait briefly for socket binding
    time.sleep(0.6)

    if auto_open:
        webbrowser.open(url)

    return url
