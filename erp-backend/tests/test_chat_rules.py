"""Chat backend C1 — what makes a channel's name and access fields valid.

Pure functions, no database. Ported from the prototype's ``channelName`` and ``cleanAccess``.
"""

from __future__ import annotations

import pytest

from app.core.errors import Invalid
from app.domain.chat.access import Member
from app.domain.chat.rules import clean_access, clean_channel_name, clean_note, clean_topic

PM = Member(id="pm", workspace_role="pm", division="Management")
LEAD = Member(id="lead", workspace_role="leader", division="Field")
STAFF = Member(id="staff", workspace_role="staff", division="Field", project_ids=("P1",))
OTHER = Member(id="other", workspace_role="intern", division="Design", project_ids=("P1",))
PEOPLE = {m.id: m for m in (PM, LEAD, STAFF, OTHER)}
PROJECT_DIVISIONS = {"P1": ["Field", "Production"]}


def _clean(**over: object):
    args: dict[str, object] = {
        "actor_id": "lead",
        "project_id": "P1",
        "project_divisions": PROJECT_DIVISIONS,
        "people": PEOPLE,
        "access": "project",
        "divisions": [],
        "member_ids": [],
        "blocked_ids": [],
        "listed": None,
    }
    args.update(over)
    return clean_access(**args)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("Gala Day 1!", "gala-day-1"),
        ("  --Hi   there--  ", "hi-there"),
        ("UPPER_case", "uppercase"),
        ("a--b---c", "a-b-c"),
        ("!!!", ""),
        ("", ""),
    ],
)
def test_a_channel_name_is_lower_case_with_hyphens(raw: str, clean: str) -> None:
    assert clean_channel_name(raw) == clean


def test_a_channel_name_is_at_most_32_characters() -> None:
    assert len(clean_channel_name("x" * 100)) == 32


def test_topic_and_note_are_trimmed_and_capped() -> None:
    assert clean_topic("  hello  ") == "hello"
    assert len(clean_topic("t" * 500)) == 120
    assert len(clean_note("n" * 500)) == 200


def test_a_divisions_rule_needs_a_division() -> None:
    with pytest.raises(Invalid):
        _clean(access="divisions", divisions=[])


def test_divisions_are_limited_to_the_ones_working_on_the_project() -> None:
    got = _clean(access="divisions", divisions=["Field", "Design", "Field"])
    assert got.divisions == ["Field"]  # Design is not on P1; the duplicate is dropped


def test_a_divisions_rule_with_only_foreign_divisions_is_refused() -> None:
    with pytest.raises(Invalid):
        _clean(access="divisions", divisions=["Design"])


def test_a_company_channel_may_use_any_of_the_three_divisions() -> None:
    got = _clean(project_id=None, access="divisions", divisions=["Design", "Production"])
    assert got.divisions == ["Design", "Production"]


def test_divisions_are_dropped_when_the_rule_is_not_by_division() -> None:
    assert _clean(access="project", divisions=["Field"]).divisions == []


def test_the_pm_cannot_be_blocked() -> None:
    assert _clean(blocked_ids=["pm", "staff"]).blocked_ids == ["staff"]


def test_nobody_blocks_themselves() -> None:
    assert _clean(actor_id="lead", blocked_ids=["lead"]).blocked_ids == []


def test_an_edit_cannot_lift_a_block_on_the_person_making_it() -> None:
    got = _clean(actor_id="staff", blocked_ids=[], was_blocked=["staff"])
    assert got.blocked_ids == ["staff"]


def test_blocking_someone_also_takes_them_off_the_member_list() -> None:
    got = _clean(member_ids=["staff", "other"], blocked_ids=["staff"])
    assert got.member_ids == ["other"] and got.blocked_ids == ["staff"]


def test_people_who_do_not_exist_are_ignored() -> None:
    got = _clean(member_ids=["ghost", "staff"], blocked_ids=["nobody"])
    assert got.member_ids == ["staff"] and got.blocked_ids == []


def test_whoever_makes_a_channel_invite_only_stays_in_it() -> None:
    assert _clean(access="invite", member_ids=["staff"]).member_ids == ["staff", "lead"]


def test_the_maker_is_not_added_if_they_are_blocked() -> None:
    got = _clean(
        actor_id="staff", access="invite", member_ids=[], blocked_ids=[], was_blocked=["staff"]
    )
    assert "staff" not in got.member_ids


def test_an_invite_only_company_channel_is_unlisted_by_default() -> None:
    assert _clean(project_id=None, access="invite").listed is False
    assert _clean(project_id=None, access="project").listed is True
    assert _clean(access="invite").listed is True  # a project's invite-only channel is listed


def test_an_explicit_listed_wins_over_the_default() -> None:
    assert _clean(project_id=None, access="invite", listed=True).listed is True
    assert _clean(access="project", listed=False).listed is False
