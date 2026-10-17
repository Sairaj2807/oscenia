"""The events module's pure rules, ported from ``scripts/verify-proto.mjs``.

Each test names the prototype check it carries over, so a rule that drifts between the two
is easy to find from either side.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace as NS
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.events import rules as r
from app.domain.events.models import InvitationTemplate
from app.domain.events.templates import (
    BUILTIN_TEMPLATES,
    REQUIRED_SECTIONS,
    SECTIONS,
    in_gallery,
    new_template,
    section_on,
    validate_template,
)

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


def test_six_builtins_three_per_family_each_well_formed() -> None:
    assert len({t["id"] for t in BUILTIN_TEMPLATES}) == 6
    for family in ("corporate", "private"):
        assert sum(t["family"] == family for t in BUILTIN_TEMPLATES) == 3
    for t in BUILTIN_TEMPLATES:
        assert t["sections"][0] == "cover" and len(set(t["sections"])) == len(t["sections"])
        assert all(SECTIONS[s]["family"] in ("both", t["family"]) for s in t["sections"])
        assert REQUIRED_SECTIONS.issubset(t["sections"])
        assert all(s in t["sections"] and s not in REQUIRED_SECTIONS for s in t["off"])


async def test_the_migration_inserted_exactly_the_builtins(db: AsyncSession) -> None:
    rows = (
        (await db.execute(select(InvitationTemplate).where(InvitationTemplate.builtin)))
        .scalars()
        .all()
    )
    assert sorted((row.as_dict() for row in rows), key=lambda t: t["id"]) == sorted(
        BUILTIN_TEMPLATES, key=lambda t: t["id"]
    )


def test_a_blank_or_a_copy_of_any_builtin_validates() -> None:
    assert validate_template(new_template("studio-1", family="private")) is None
    assert validate_template(new_template("studio-2", family="corporate")) is None
    for b in BUILTIN_TEMPLATES:
        copy = new_template(f"studio-{b['id']}", base=b)
        assert validate_template(copy) is None
        assert copy["name"] == f"{b['name']} copy" and copy["status"] == "draft"


GOOD = new_template("studio-1")


@pytest.mark.parametrize(
    "patch",
    [
        {"id": "gala"},
        {"name": "  "},
        {"name": "x" * 41},
        {"palette": {**GOOD["palette"], "accent": "red"}},
        {"palette": {"bg": "#fff", "surface": "#ffffff", "accent": "#000000", "text": "#000"}},
        {"fonts": {**GOOD["fonts"], "heading": "comic-sans"}},
        {"cover": "carousel"},
        {"ornament": "stars"},
        {"family": "party"},
        {"sections": ["message", "cover", "details", "rsvp"]},
        {"sections": ["cover", "details", "rsvp", "rsvp"]},
        {"sections": ["cover", "details", "agenda", "rsvp"], "off": []},
        {"sections": ["cover", "details", "message"], "off": []},
        {"off": ["rsvp"]},
        {"off": ["agenda"]},
        {"art": {**GOOD["art"], "frame": "data:image/svg+xml,<svg/>"}},
        {"art": {"logo": None}},
        {"status": "live"},
        # Malformed shapes say what is wrong rather than raising.
        {"sections": [{}]},
        {"off": [[]]},
        {"fonts": {"heading": ["x"], "body": "inter", "script": "vibes"}},
        {"family": ["private"]},
        {"art": {1: None}},
    ],
)
def test_each_kind_of_bad_template_is_refused_with_a_reason(patch: dict[str, Any]) -> None:
    assert isinstance(validate_template({**GOOD, **patch}), str)


def test_gallery_and_section_toggles() -> None:
    gala = next(t for t in BUILTIN_TEMPLATES if t["id"] == "gala")
    assert in_gallery(gala) and not in_gallery(None)
    assert not in_gallery({**GOOD, "status": "draft"}) and in_gallery(
        {**GOOD, "status": "published"}
    )
    toggles = {"speakers": True, "rsvp": False, "couple": True}
    assert section_on(gala, toggles, "speakers") and not section_on(gala, toggles, "hosts")
    assert section_on(gala, toggles, "rsvp"), "a required section cannot be switched off"
    assert not section_on(gala, toggles, "couple"), "outside the template it never shows"


def test_empty_sections_are_skipped_and_content_survives_a_template_change() -> None:
    gala = next(t for t in BUILTIN_TEMPLATES if t["id"] == "gala")
    royal = next(t for t in BUILTIN_TEMPLATES if t["id"] == "royal")
    content = r.blank_content(name="X", date_="2026-09-01")
    assert "agenda" not in r.visible_sections(gala, {}, content)
    content["agenda"]["rows"] = [{"time": "19:00", "label": "Dinner"}]
    assert "agenda" in r.visible_sections(gala, {}, content)
    assert "agenda" not in r.visible_sections(royal, {}, content)
    assert r.visible_sections(None, {}, content) == []


# ---------------------------------------------------------------------------
# Guests, matching, dates
# ---------------------------------------------------------------------------


def _g(**kw: Any) -> NS:
    """A guest as stored: ``phone_norm`` is what the database keeps beside the phone."""
    g = NS(**{"phone": "", "email": "", "rsvp": None, **kw})
    g.phone_norm = r.norm_phone(g.phone)
    return g


def test_08_and_plus_62_are_the_same_phone() -> None:
    assert r.norm_phone("0812-1100 2200") == r.norm_phone("+62 812 1100 2200")


def test_matching_phone_first_then_an_unambiguous_unreplied_email() -> None:
    listed = _g(phone="0811 1000 0001", email="dewi@x.id")
    replied = _g(phone="0811 1000 0002", email="budi@x.id", rsvp="Attending")
    guests = [listed, replied]
    assert r.match_guest(guests, phone="+62 811 1000 0001", email="") is listed
    assert r.match_guest(guests, phone="", email="DEWI@x.id") is listed
    assert r.match_guest(guests, phone="0899 0000 1111", email="budi@x.id") is None
    home = [
        _g(phone="0811 5555 0001", email="home@x.com"),
        _g(phone="0811 5555 0002", email="home@x.com"),
    ]
    assert r.match_guest(home, phone="0899 1", email="home@x.com") is None


def test_pax_is_clamped_to_the_event_and_the_hard_limit() -> None:
    assert r.clamp_pax(9, 2) == 2
    assert r.clamp_pax(12, 20) == 12 and r.clamp_pax(40, 20) == 20
    assert r.clamp_pax(99, 99) == r.MAX_PAX_LIMIT
    assert r.clamp_pax("x", 5) == 1 and r.clamp_pax(0, 5) == 1


def test_categories_and_tables() -> None:
    assert r.to_category("vip") == "VIP" and r.to_category("Press") == "Regular"
    assert r.clean_table("  VIP-1  ") == "VIP-1" and r.clean_table(None) == ""
    assert len(r.clean_table("Garden " + "x" * 60)) == 30


def test_rsvp_deadline_and_window() -> None:
    today = date(2026, 7, 26)
    assert r.default_rsvp_deadline(date(2026, 7, 29), today) == date(2026, 7, 29)
    assert r.default_rsvp_deadline(date(2026, 12, 10), today) == date(2026, 12, 3)
    assert r.rsvp_open(
        published=True, deadline=date(2026, 8, 7), event_date=date(2026, 8, 14), today=today
    )
    assert not r.rsvp_open(
        published=False, deadline=date(2026, 8, 7), event_date=date(2026, 8, 14), today=today
    )
    assert not r.rsvp_open(
        published=True, deadline=date(2026, 7, 25), event_date=date(2026, 8, 14), today=today
    )
    assert not r.rsvp_open(
        published=True, deadline=date(2026, 8, 7), event_date=date(2026, 7, 20), today=today
    )
    assert r.parse_iso_date("2026-02-30") is None and r.parse_iso_date("") is None
    assert r.parse_iso_date("2026-02-28") == date(2026, 2, 28)


def test_safe_links_and_emails() -> None:
    assert r.safe_link("javascript:alert(1)") == "" and r.safe_link(
        " https://maps.google.com/?q=x "
    )
    assert r.is_email(" omar@home.id ") and not r.is_email("omar at home")


# ---------------------------------------------------------------------------
# The guest-list CSV
# ---------------------------------------------------------------------------


def test_csv_header_in_any_order_with_a_quoted_comma() -> None:
    rows = r.parse_guest_csv(
        'Phone,Name,Table\r\n0811 1111 2222,"Wijaya, Budi",VIP 1\n\n'
        "0811 3333 4444,Sari Dewi,\nno-phone-row,,"
    )
    assert [(g.name, g.phone, g.table) for g in rows] == [
        ("Wijaya, Budi", "0811 1111 2222", "VIP 1"),
        ("Sari Dewi", "0811 3333 4444", ""),
    ]


def test_csv_without_a_header_semicolons_and_categories() -> None:
    bare = r.parse_guest_csv("Budi,0811 5555 6666,budi@x.com,T2")
    assert bare[0].email == "budi@x.com" and bare[0].table == "T2"
    assert len(r.parse_guest_csv("Name;Phone\nBudi;0811 2222 3333")) == 1
    cats = r.parse_guest_csv(
        "name,phone,category\nAyu,0811 7000 1000,vip\nBima,0811 7000 2000,Press"
    )
    assert [g.category for g in cats] == ["VIP", "Regular"]


def test_an_unclosed_quote_spoils_only_its_own_row() -> None:
    assert [g.name for g in r.parse_guest_csv('name,phone\n"Broken,0811 1\nOk,0811 2222 3333')] == [
        "Ok"
    ]


# ---------------------------------------------------------------------------
# Custom questions (R7)
# ---------------------------------------------------------------------------


def _q(**kw: Any) -> NS:
    base = {
        "key": "Q-1",
        "label": "L",
        "type": "text",
        "options": [],
        "multi": False,
        "required": False,
        "attending_only": True,
    }
    return NS(**{**base, **kw})


QS = [
    _q(key="Q-1", label="Meal", type="dropdown", options=["Beef", "Fish"], required=True),
    _q(key="Q-2", label="Topics", type="choice", options=["A", "B", "C"], multi=True),
    _q(key="Q-3", label="Heard of us", attending_only=False),
    _q(
        key="Q-4",
        label="Not ready",
        type="choice",
        options=["Only one"],
        required=True,
        attending_only=False,
    ),
    _q(key="Q-5", label="  ", required=True, attending_only=False),
]


def test_who_is_asked_what() -> None:
    assert [q.key for q in r.questions_for(QS, True)] == ["Q-1", "Q-2", "Q-3"]
    assert [q.key for q in r.questions_for(QS, False)] == ["Q-3"]


def test_answers_are_cleaned_and_missing_required_ones_reported() -> None:
    answers, missing = r.clean_answers(
        QS,
        True,
        {"Q-1": "Pork", "Q-2": ["A", "Z", "A", "C"], "Q-3": "  " + "x" * 600, "Q-9": "stray"},
    )
    assert missing == ["Meal"] and "Q-1" not in answers
    assert answers["Q-2"] == ["A", "C"] and len(answers["Q-3"]) == r.MAX_ANSWER_LENGTH
    assert "Q-9" not in answers
    single = r.clean_answers(
        [_q(key="Q-2", label="T", type="choice", options=["A", "B", "C"])],
        True,
        {"Q-2": ["B", "C"]},
    )
    assert single[0]["Q-2"] == "B"
    assert r.clean_answers(QS, True, {"Q-1": "Fish", "Q-3": ["a"]})[0] == {"Q-1": "Fish"}


def test_answer_counts_cover_attending_guests_only() -> None:
    guests = [
        NS(rsvp="Attending", answers={"Q-1": "Beef"}),
        NS(rsvp="Attending", answers={"Q-1": "Beef"}),
        NS(rsvp="Attending", answers={}),
        NS(rsvp="Declined", answers={"Q-1": "Fish"}),
    ]
    counts, none = r.answer_counts(QS[0], guests)
    assert counts == {"Beef": 2, "Fish": 0} and none == 1
    assert (
        r.answer_counts(
            _q(key="Q", options=["x"]), [NS(rsvp="Attending", answers={"Q": "constructor"})]
        )[1]
        == 1
    )


def test_options_are_trimmed_deduplicated_never_blank() -> None:
    assert r.clean_options(["  Yes ", "Yes", "", "No"]) == ["Yes", "No"]


# ---------------------------------------------------------------------------
# Content, checkpoints, wishes, reports
# ---------------------------------------------------------------------------


def test_section_content_is_capped_and_holds_only_file_references() -> None:
    assert r.clean_section({"title": "T" * 900})["title"] == "T" * 300
    assert len(r.clean_section({"body": "b" * 3000})["body"]) == 2000
    assert r.clean_section({"image": "data:image/png;base64,AAAA"})["image"] is None
    ref = {"key": "k", "size": 1, "name": "a.png", "type": "image/png", "extra": "x"}
    assert r.clean_section({"photos": [ref, "data:x", None]})["photos"] == [
        {"key": "k", "name": "a.png", "size": 1, "type": "image/png"}
    ]
    assert len(r.clean_section({"rows": [{"label": str(i)} for i in range(99)]})["rows"]) == 30


def test_section_content_depth_and_size_are_bounded() -> None:
    nested: dict[str, Any] = {}
    cur = nested
    for _ in range(10):
        cur["x"] = {}
        cur = cur["x"]
    with pytest.raises(r.ContentTooLarge):
        r.clean_section(nested)
    with pytest.raises(r.ContentTooLarge):
        r.clean_section({f"k{i}": [{"text": "x" * 2000} for _ in range(50)] for i in range(5)})


def test_checkpoint_admission_and_wish_visibility() -> None:
    assert r.checkpoint_admits([], "Regular") and r.checkpoint_admits(["VIP"], "VIP")
    assert not r.checkpoint_admits(["VIP"], "Regular")
    assert r.wish_visible(hidden=False, approved=False, hold=False)
    assert not r.wish_visible(hidden=False, approved=False, hold=True)
    assert r.wish_state(hidden=True, approved=True, hold=False) == "hidden"
    assert r.wish_state(hidden=False, approved=False, hold=True) == "waiting"


def test_the_reconciliation_grid() -> None:
    guests = [
        NS(
            rsvp="Attending",
            checked_in_at="t",
            on_master_list=True,
            walk_in=False,
            pax=2,
            allergies="",
        ),
        NS(
            rsvp="Attending",
            checked_in_at=None,
            on_master_list=True,
            walk_in=False,
            pax=1,
            allergies="nuts",
        ),
        NS(rsvp=None, checked_in_at="t", on_master_list=False, walk_in=True, pax=1, allergies=""),
        NS(
            rsvp="Declined",
            checked_in_at=None,
            on_master_list=True,
            walk_in=False,
            pax=0,
            allergies="",
        ),
    ]
    grid = r.reconcile(guests)
    assert [
        len(grid[k]) for k in ("rsvp_came", "rsvp_no_show", "no_rsvp_came", "no_rsvp_no_show")
    ] == [1, 1, 1, 1]
    s = r.event_stats(guests)
    assert (s.invited, s.attending, s.declined, s.pax, s.allergies, s.walk_ins, s.checked_in) == (
        3,
        2,
        1,
        3,
        1,
        1,
        2,
    )
