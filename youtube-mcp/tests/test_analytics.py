"""
Tests for YouTube analytics date parsing, calculations, and data normalization.
"""

import datetime

import pytest

from youtube_mcp.analytics import TRAFFIC_SOURCE_MAP, parse_date_string


def test_parse_date_iso():
    assert parse_date_string("2026-05-15") == "2026-05-15"
    assert parse_date_string("2025-01-01") == "2025-01-01"


def test_parse_date_relative_today():
    today = datetime.date.today().isoformat()
    assert parse_date_string("today") == today
    assert parse_date_string("now") == today


def test_parse_date_relative_yesterday():
    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    assert parse_date_string("yesterday") == yesterday


def test_parse_date_relative_days_ago():
    seven_days = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    assert parse_date_string("7daysAgo") == seven_days
    assert parse_date_string("30daysago") == (datetime.date.today() - datetime.timedelta(days=30)).isoformat()


def test_parse_date_invalid():
    with pytest.raises(ValueError):
        parse_date_string("not-a-date")


def test_traffic_sources_coverage():
    assert "YT_SEARCH" in TRAFFIC_SOURCE_MAP
    assert TRAFFIC_SOURCE_MAP["YT_SEARCH"] == "YouTube Search"
    assert TRAFFIC_SOURCE_MAP["RELATED_VIDEO"] == "Suggested / Related Videos"
