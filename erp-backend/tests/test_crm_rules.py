"""The relationship rules, against the prototype's own answers.

``tests/fixtures/crm_relations_matrix.json`` is written by running the prototype's ``lib/crm.js``
over a grid of inputs (``erp-frontend/scripts/gen-crm-fixture.mjs``). Every case here must come
out the same in the Python port, including the awkward ones: a tie between two months, a 29
February in a year without one, a nudge that falls in the previous year, an edition moved to
another month.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.domain.crm import contacts, rules

MATRIX: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "crm_relations_matrix.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", MATRIX["usualMonth"], ids=lambda c: str(c["history"]))
def test_the_usual_month_matches_the_prototype(case: dict[str, Any]) -> None:
    assert rules.usual_month(case["history"]) == case["out"]


@pytest.mark.parametrize(
    "case",
    MATRIX["nextNudge"],
    ids=lambda c: f"{c['history']}|{c['today']}|{c['lead']}",
)
def test_the_next_nudge_matches_the_prototype(case: dict[str, Any]) -> None:
    got = rules.next_nudge(case["history"], case["lead"], case["today"])
    expected = case["out"]
    if expected is None:
        assert got is None
        return
    assert got == {
        "month": expected["month"],
        "edition": expected["edition"],
        "nudge_on": expected["nudgeOn"],
    }


@pytest.mark.parametrize("case", MATRIX["isMonthDay"], ids=lambda c: repr(c["value"]))
def test_which_month_days_exist_matches_the_prototype(case: dict[str, Any]) -> None:
    assert rules.is_month_day(case["value"]) is case["out"]


@pytest.mark.parametrize(
    "case", MATRIX["nextOccurrence"], ids=lambda c: f"{c['monthDay']}|{c['today']}"
)
def test_the_next_occurrence_matches_the_prototype(case: dict[str, Any]) -> None:
    assert rules.next_occurrence(case["monthDay"], case["today"]) == case["out"]


@pytest.mark.parametrize(
    "case",
    MATRIX["calendar"],
    ids=lambda c: f"{c['today']}|{c['days']}|{len(c['relations'])}",
)
def test_a_whole_calendar_matches_the_prototype(case: dict[str, Any]) -> None:
    got = rules.relationship_calendar(
        MATRIX["clients"], case["relations"], case["today"], case["days"]
    )
    keep = ("kind", "clientId", "client", "date", "inDays", "key", "title", "detail")

    def shape(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # JSON has no `undefined`: a missing role is absent there and "" here, the same thing.
        return [{k: item.get(k) or None for k in keep} for item in items]

    assert shape(got) == shape(case["out"])


def test_a_nudge_that_lands_in_the_previous_year_rolls_back_correctly() -> None:
    # A January event nudged three months ahead is nudged in October of the year before.
    got = rules.next_nudge(["2024-01", "2025-01"], 3, "2026-01-01")
    assert got == {"month": 1, "edition": "2026-01", "nudge_on": "2025-10-01"}, "already overdue"
    # Once January 2026 is booked the next one is 2027, nudged in October 2026.
    got = rules.next_nudge(["2025-01", "2026-01"], 3, "2026-01-01")
    assert got == {"month": 1, "edition": "2027-01", "nudge_on": "2026-10-01"}


def test_a_leap_day_is_kept_on_the_28th_in_other_years() -> None:
    assert rules.next_occurrence("02-29", "2027-01-01") == "2027-02-28"
    assert rules.next_occurrence("02-29", "2028-01-01") == "2028-02-29"


def test_the_greeting_text_names_the_person_or_the_company() -> None:
    birthday = rules.greeting_text(rules.KIND_BIRTHDAY, client="Aurora", title="Ibu Sari")
    assert "Ibu Sari" in birthday and "birthday" in birthday
    anniversary = rules.greeting_text(
        rules.KIND_ANNIVERSARY, client="Aurora", title="7 years with Oscenia"
    )
    assert "Aurora" in anniversary and "7 years" in anniversary


# --- the contact list and who a campaign reaches ---------------------------------------------


@pytest.mark.parametrize("case", MATRIX["contacts"], ids=lambda c: c["name"])
def test_the_merged_contact_list_matches_the_prototype(case: dict[str, Any]) -> None:
    assert contacts.merge_contacts(case["guests"], case["events"]) == case["out"]


@pytest.mark.parametrize(
    "case", MATRIX["audience"], ids=lambda c: f"{c['set']}|{'-'.join(c['picked'])[:30]}"
)
def test_a_campaign_audience_matches_the_prototype(case: dict[str, Any]) -> None:
    source = next(c for c in MATRIX["contacts"] if c["name"] == case["set"])
    merged = contacts.merge_contacts(source["guests"], source["events"])
    recipients, skipped = contacts.campaign_audience(merged, case["picked"])
    assert [c["key"] for c in recipients] == case["recipients"]
    assert [c["key"] for c in skipped] == case["skipped"]


def test_phone_formats_merge_and_a_shared_inbox_does_not() -> None:
    assert contacts.contact_key("0812 3456 7890", "") == contacts.contact_key(
        "+62 812-3456-7890", "x@y"
    )
    assert contacts.contact_key("", " A@B.test ") == "e:a@b.test"
    assert contacts.contact_key("", "") is None and contacts.contact_key(None, None) is None
