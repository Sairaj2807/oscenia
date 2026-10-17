"""Chat backend M — who may read, manage and post a meeting's minutes.

``tests/fixtures/chat_meeting_matrix.json`` holds the prototype's own answers (written by
``erp-frontend/scripts/export-meeting-fixtures.mjs`` from the real ``meetings.js``): every seed
persona against a meeting in every channel, in each access mode, with and without view-only
files. The port must agree on all of them. The rules that were never client functions (changing
the access, writing and posting the minutes) are checked by hand below.

Pure functions, no database.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.domain.chat.access import Channel, Member
from app.domain.chat.meeting_rules import (
    Meeting,
    access_change_allowed,
    can_manage_meeting,
    can_open_meeting_files,
    can_post_summary,
    can_see_meeting,
    can_write_summary,
    namable,
)

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "chat_meeting_matrix.json").read_text("utf-8")
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
        access=c["access"],
        divisions=tuple(c["divisions"]),
        member_ids=frozenset(c["member_ids"]),
        blocked_ids=frozenset(c["blocked_ids"]),
        listed=c["listed"],
    )
    for c in FIXTURE["channels"]
}


def meeting_of(row: dict[str, Any]) -> Meeting:
    return Meeting(
        id=row["id"],
        host_id=row["host"],
        participant_ids=frozenset(row["participants"]),
        reader_ids=frozenset(row["readers"]),
        access=row["access"],
        files_view_only=row["files_view_only"],
    )


def test_the_fixture_covers_what_it_should() -> None:
    assert len(FIXTURE["meetings"]) == len(CHANNELS) * 3 * 2 and len(MEMBERS) == 10
    # Something is allowed and something is refused, or the parity below proves little.
    assert any(m["see"] for m in FIXTURE["meetings"]) and any(
        len(m["see"]) < len(MEMBERS) for m in FIXTURE["meetings"]
    )


@pytest.mark.parametrize("row", FIXTURE["meetings"], ids=lambda r: r["id"])
def test_every_answer_matches_the_prototype(row: dict[str, Any]) -> None:
    meeting, channel = meeting_of(row), CHANNELS[row["channel"]]
    for mid, member in MEMBERS.items():
        assert can_see_meeting(member, meeting, channel, PD) == (mid in row["see"]), (mid, "see")
        assert can_manage_meeting(member, meeting, channel) == (mid in row["manage"]), (
            mid,
            "manage",
        )
        assert can_open_meeting_files(member, meeting, channel, PD) == (mid in row["files"]), (
            mid,
            "files",
        )


# --- hand-written: the rules with no client function -------------------------------------

PM, HOST, RINA, LATE = MEMBERS["M-01"], MEMBERS["M-02"], MEMBERS["M-05"], MEMBERS["M-06"]
GALA = next(c for c in CHANNELS.values() if c.project_id and not c.dm and c.access == "project")
DM = CHANNELS["edge-dm"]


def mtg(**kw: Any) -> Meeting:
    base: dict[str, Any] = {
        "id": "m",
        "host_id": HOST.id,
        "participant_ids": frozenset({HOST.id, RINA.id}),
    }
    return Meeting(**{**base, **kw})


def test_the_host_reads_and_manages_even_if_not_listed_among_the_participants() -> None:
    m = mtg(participant_ids=frozenset({RINA.id}))  # the host is not in the list
    assert can_see_meeting(HOST, m, GALA, PD) and can_manage_meeting(HOST, m, GALA)
    assert can_open_meeting_files(
        HOST, mtg(participant_ids=frozenset(), files_view_only=True), GALA, PD
    )


def test_the_channel_must_be_openable_for_anyone_to_read_even_the_host() -> None:
    closed = Channel(id="z", project_id=None, access="invite")  # nobody is let in
    assert not can_see_meeting(HOST, mtg(), closed, PD)
    assert not can_see_meeting(RINA, mtg(access="channel"), closed, PD), "a participant too"


def test_a_dm_call_never_leaves_its_two_people() -> None:
    m = mtg(access="channel")  # even a (wrongly) wide access cannot open a DM call
    assert not can_see_meeting(PM, m, DM, PD) and not can_see_meeting(LATE, m, DM, PD)
    assert can_see_meeting(HOST, m, DM, PD) and can_see_meeting(RINA, m, DM, PD)
    assert not can_manage_meeting(PM, m, DM) and can_manage_meeting(HOST, m, DM)


def test_the_access_of_a_dm_call_cannot_be_widened_and_unknown_modes_are_refused() -> None:
    m = mtg()
    assert access_change_allowed(HOST, m, DM, "participants")
    assert not access_change_allowed(HOST, m, DM, "channel")
    assert not access_change_allowed(HOST, m, DM, "people")
    assert access_change_allowed(HOST, m, GALA, "channel")
    assert not access_change_allowed(HOST, m, GALA, "everyone")
    assert not access_change_allowed(RINA, m, GALA, "channel"), "a participant is not the host"
    assert access_change_allowed(PM, m, GALA, "people"), "the PM may, on a channel call"
    assert not access_change_allowed(None, m, GALA, "channel")


def test_only_people_who_can_open_the_channel_can_be_named() -> None:
    invite = Channel(id="c", project_id=None, access="invite", member_ids=frozenset({RINA.id}))
    assert namable([RINA, LATE], invite, PD) == [RINA]


def test_the_first_minutes_are_anyones_to_write_but_replacing_them_is_the_hosts() -> None:
    open_ = mtg(access="channel")
    assert can_write_summary(LATE, open_, GALA, PD), "open to the channel: anyone in it may"
    first = mtg(access="participants")
    assert can_write_summary(RINA, first, GALA, PD), "a participant writes the first minutes"
    assert not can_write_summary(LATE, first, GALA, PD), "someone who cannot read it cannot write"
    done = mtg(has_summary=True)
    assert not can_write_summary(RINA, done, GALA, PD), "replacing is the host's"
    assert can_write_summary(HOST, done, GALA, PD) and can_write_summary(PM, done, GALA, PD)


def test_posting_the_minutes_needs_everything_to_line_up() -> None:
    ok = mtg(access="channel", has_summary=True, log_channel_id=GALA.id)
    assert can_post_summary(HOST, ok, GALA, GALA, PD)
    assert not can_post_summary(HOST, mtg(access="people", has_summary=True, log_channel_id="x"),
                                GALA, GALA, PD), "only when open to the whole channel"  # fmt: skip
    assert not can_post_summary(HOST, mtg(access="channel", log_channel_id="x"), GALA, GALA, PD), (
        "nothing to post"
    )
    posted = mtg(access="channel", has_summary=True, log_channel_id=GALA.id, summary_posted=True)
    assert not can_post_summary(HOST, posted, GALA, GALA, PD), "not twice"
    nowhere = mtg(access="channel", has_summary=True, log_channel_id=None)
    assert not can_post_summary(HOST, nowhere, GALA, GALA, PD), "no channel to post to"
    assert not can_post_summary(HOST, ok, DM, DM, PD), "never in a DM"
    assert not can_post_summary(HOST, ok, GALA, None, PD), "the destination is gone"
    closed = Channel(id="z", project_id=None, access="invite")
    assert not can_post_summary(HOST, ok, GALA, closed, PD), "destination the poster cannot open"
    unread = mtg(
        access="channel", has_summary=True, log_channel_id="x", participant_ids=frozenset({HOST.id})
    )
    moved_off = CHANNELS["edge-moved-off"]  # LATE is not on its project: cannot read it
    assert not can_post_summary(LATE, unread, moved_off, GALA, PD), "who cannot read it"
