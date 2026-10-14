"""Local stdio MCP bridge for the Chitra Yantra agent API."""

from __future__ import annotations

import argparse
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:
    from mcp.server.fastmcp import FastMCP  # type: ignore[no-redef]

BASE_URL = os.environ.get("CHITRA_AGENT_URL", "http://127.0.0.1:7842/api/agent/v1").rstrip("/")

mcp = FastMCP(
    name="chitra-mcp",
    instructions=(
        "Controls local Chitra Yantra video-production workspaces. Starts asynchronous workflows, "
        "then use workspace status or events to observe progress. Global automation uploads only privately."
    ),
)


def api(path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(f"{BASE_URL}{path}", data=data, method=method, headers={"Accept": "application/json", "Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
            message = details.get("error", str(error))
        except Exception:
            message = str(error)
        return {"success": False, "error": message, "status": error.code}
    except URLError as error:
        return {"success": False, "error": f"Cannot reach Chitra Yantra at {BASE_URL}: {error.reason}"}


@mcp.tool()
def chitra_list_channels() -> dict[str, Any]:
    """List local channels and known Chitra Yantra workspaces."""
    return api("/channels")


@mcp.tool()
def chitra_create_and_run(
    channel_id: str,
    topic: str = "",
    proactive: bool = False,
    target_duration_min: int | None = None,
    research_max_angles: int | None = None,
    research_max_synthesis_passes: int | None = None,
) -> dict[str, Any]:
    """Create a workspace and start global automation from a topic or proactive discovery."""
    settings: dict[str, Any] = {}
    if target_duration_min is not None:
        settings["targetDurationMin"] = target_duration_min
    if research_max_angles is not None:
        settings["researchMaxAngles"] = research_max_angles
    if research_max_synthesis_passes is not None:
        settings["researchMaxSynthesisPasses"] = research_max_synthesis_passes
    return api("/workspaces", "POST", {
        "channelId": channel_id, "topic": topic, "proactive": proactive, "start": True,
        "mode": "global", "settings": settings,
    })


@mcp.tool()
def chitra_start_automation(project_key: str, topic: str = "", proactive: bool = False, start_stage: str = "") -> dict[str, Any]:
    """Start or continue global automation for an existing workspace."""
    return api(f"/workspaces/{project_key}/automation", "POST", {
        "mode": "global", "topic": topic, "proactive": proactive, "startStage": start_stage or None,
    })


@mcp.tool()
def chitra_workspace_status(project_key: str) -> dict[str, Any]:
    """Return stage state, runs, artifacts, workflow state, and private-publication status."""
    return api(f"/workspaces/{project_key}")


@mcp.tool()
def chitra_workspace_events(project_key: str, after_event_id: int = 0) -> dict[str, Any]:
    """Read ordered workflow events after an event ID for progress monitoring."""
    return api(f"/workspaces/{project_key}/events?after={after_event_id}")


@mcp.tool()
def chitra_start_research(project_key: str, direction: str = "", adapter: str = "") -> dict[str, Any]:
    """Start adaptive deep research: one planner, 3-10 research angles, 1-3 synthesis passes, and mandatory verification."""
    payload: dict[str, Any] = {"direction": direction}
    if adapter:
        payload["adapter"] = adapter
    return api(f"/workspaces/{project_key}/research", "POST", payload)


@mcp.tool()
def chitra_workflow_action(project_key: str, workflow_id: str, action: str, reason: str = "") -> dict[str, Any]:
    """Resume, pause, or cancel an automation workflow."""
    if action not in {"resume", "pause", "cancel"}:
        return {"success": False, "error": "action must be resume, pause, or cancel"}
    return api(f"/workspaces/{project_key}/automation/{workflow_id}/{action}", "POST", {"reason": reason})


@mcp.tool()
def chitra_run_stage(project_key: str, stage_id: str, substage: str = "", iteration_note: str = "") -> dict[str, Any]:
    """Run one stage manually; use this for a workflow paused for review or repair."""
    return api(f"/workspaces/{project_key}/stages/{stage_id}/run", "POST", {"substage": substage or None, "iterationNote": iteration_note})


@mcp.tool()
def chitra_cancel_run(run_id: str) -> dict[str, Any]:
    """Cancel a queued or running stage run."""
    return api(f"/runs/{run_id}", "DELETE")


def main() -> None:
    parser = argparse.ArgumentParser(description="Chitra Yantra MCP server")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    args = parser.parse_args()
    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
