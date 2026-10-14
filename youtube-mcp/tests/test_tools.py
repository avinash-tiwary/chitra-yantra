import asyncio

from youtube_mcp.server import mcp


def test_fastmcp_tools_registered():
    """Verifies that all 9 tools are properly registered on the FastMCP instance."""
    tools = asyncio.run(mcp.list_tools())
    tool_names = [t.name for t in tools]

    expected_tools = [
        "youtube_get_channel_overview",
        "youtube_upload_video",
        "youtube_set_thumbnail",
        "youtube_update_video",
        "youtube_list_videos",
        "youtube_get_video_details",
        "youtube_get_video_analytics",
        "youtube_get_channel_performance",
        "youtube_get_retention_curve",
        "youtube_launch_dashboard",
    ]

    for expected in expected_tools:
        assert expected in tool_names, f"Expected tool '{expected}' was not registered on FastMCP."


def test_server_metadata():
    """Verifies server naming."""
    assert mcp.name == "youtube-mcp"
