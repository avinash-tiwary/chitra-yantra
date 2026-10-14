"""
Creator Analytics Dashboard module for YouTube MCP.
Provides an interactive browser-based dashboard for creators to monitor stats,
traffic sources, audience retention, and video SEO.
"""

from youtube_mcp.dashboard.runner import launch_dashboard_in_background, run_dashboard

__all__ = ["run_dashboard", "launch_dashboard_in_background"]
