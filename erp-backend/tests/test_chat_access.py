"""Chat backend C0 — the channel access rules.

``tests/fixtures/chat_access_matrix.json`` holds the prototype's own answers (written by
``erp-frontend/scripts/export-access-fixtures.mjs`` from the real ``workspaceAccess.js``):
every seed persona against every seed channel plus edge cases. The server's port must give
the same answer to every one of them, so the two rule books cannot drift apart unnoticed.

Pure functions, no database.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.domain.chat.access import (
    Channel,
    Member,
    can_create_channel,
    can_manage_channel,
    can_open_channel,
    discoverable_channels,
    home_channel,
    member_project_ids,
    visible_channels,
)

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "chat_access_matrix.json").read_text("utf-8")
)
PD: dict[str, list[str]] = FIXTURE["project_divisions"]

MEMBERS = {
    m["id"]: Member(
        id=m["id"],
        workspace_role=m["workspace_role"],
        division=m["division"],
        project_ids=tuple(m["project_ids"]),
    )
    for m in FIXTURE["members"]
}
CHANNELS = {
    c["id"]: Channel(
        id=c["id"],
        project_id=c["project_id"],
        dm=c["dm"],
        voice=c["voice"],
        access=c["access"],
        divisions=tuple(c["divisions"]),
        member_ids=frozenset(c["member_ids"]),
        blocked_ids=frozenset(c["blocked_ids"]),
        listed=c["listed"],
    )
    for c in FIXTURE["channels"]
}

pytestmark = pytest.mark.phase2


@pytest.mark.parametrize("member_id", list(MEMBERS))
def test_who_can_open_what_matches_the_prototype(member_id: str) -> None:
    got = [c.id for c in visible_channels(MEMBERS[member_id], CHANNELS.values(), PD)]
    assert got == FIXTURE["open"][member_id]


@pytest.mark.parametrize("member_id", list(MEMBERS))
def test_what_is_listed_but_locked_matches_the_prototype(member_id: str) -> None:
    got = [c.id for c in discoverable_channels(MEMBERS[member_id], CHANNELS.values(), PD)]
    assert got == FIXTURE["discoverable"][member_id]


@pytest.mark.parametrize("member_id", list(MEMBERS))
def test_who_can_manage_what_matches_the_prototype(member_id: str) -> None:
    got = [c.id for c in CHANNELS.values() if can_manage_channel(MEMBERS[member_id], c, PD)]
    assert got == FIXTURE["manage"][member_id]


@pytest.mark.parametrize("member_id", list(MEMBERS))
def test_who_can_create_where_matches_the_prototype(member_id: str) -> None:
    got = {
        scope: can_create_channel(MEMBERS[member_id], None if scope == "company" else scope, PD)
        for scope in FIXTURE["create"][member_id]
    }
    assert got == FIXTURE["create"][member_id]


# --- the rules that matter most, stated outright rather than only by replay -------------


def test_nobody_but_the_two_people_can_open_a_dm_not_even_the_pm() -> None:
    dm = CHANNELS["edge-dm"]
    assert can_open_channel(MEMBERS["M-05"], dm, PD)
    assert can_open_channel(MEMBERS["M-06"], dm, PD)
    assert not can_open_channel(MEMBERS["M-01"], dm, PD)  # the PM
    assert not can_manage_channel(MEMBERS["M-01"], dm, PD)
    found = discoverable_channels(MEMBERS["M-07"], CHANNELS.values(), PD)
    assert dm.id not in [c.id for c in found]


def test_the_pm_is_never_blocked_but_everyone_else_is() -> None:
    blocked = CHANNELS["edge-blocked"]
    assert can_open_channel(MEMBERS["M-01"], blocked, PD)
    assert not can_open_channel(MEMBERS["M-05"], blocked, PD)


def test_being_let_in_does_not_survive_leaving_the_project() -> None:
    # M-10 is named on this channel but is not on the Wedding project.
    assert not can_open_channel(MEMBERS["M-10"], CHANNELS["edge-moved-off"], PD)


def test_a_missing_member_or_channel_opens_nothing() -> None:
    assert not can_open_channel(None, CHANNELS["ch-general"], PD)
    assert not can_open_channel(MEMBERS["M-05"], None, PD)
    assert visible_channels(None, CHANNELS.values(), PD) == []
    assert member_project_ids(None, PD) == []


def test_the_home_channel_is_found_by_its_rule() -> None:
    home = home_channel(CHANNELS.values(), None)
    assert home is not None
    assert home.access == "project" and home.project_id is None and not home.dm
    assert home_channel([], None) is None
