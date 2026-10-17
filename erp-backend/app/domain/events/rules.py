"""The events module's business rules, as pure functions.

Ported from the prototype's ``src/lib/events.js`` and ``src/lib/invites.js`` — the same
rules its ``scripts/verify-proto.mjs`` checks, which ``tests/test_events_rules.py`` ports.
Nothing here touches the database, so each rule is tested on its own and the service layer
reads as a sequence of decisions rather than a tangle of string handling.

Two deliberate departures from the prototype, both because a server sees input a browser
form never sends:

* **No inline images.** The prototype keeps an old inline photo (a ``data:`` URL) in the
  content; the server stores only file references (``{key, name, size, type}``). Real files
  arrive through storage (Phase 3), and a data URL in JSONB is megabytes in every read.
* **Bounded content.** A section is cleaned to a maximum depth and size, so one PUT cannot
  park an arbitrarily large or deeply nested document in the invitation.
"""

from __future__ import annotations

import csv
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Literal, Protocol

from app.domain.events.templates import section_on

# ---------------------------------------------------------------------------
# Guests
# ---------------------------------------------------------------------------

#: Guest categories (client round 1, R2). Anyone without one is Regular.
GUEST_CATEGORIES = ("VIP", "Media", "Regular", "Vendor")

#: Most people one invitation may bring, including the guest (R6: raised from 10).
MAX_PAX_LIMIT = 50

#: Table numbers are free text (round 4): "T1", "VIP-1", "Garden 3"… trimmed and capped.
MAX_TABLE_LENGTH = 30

#: A phone needs this many digits to be on the list (``addGuests``, the walk-in desk).
MIN_PHONE_DIGITS = 8

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def to_category(value: Any = "") -> str:
    """Case-insensitive match to a category name; anything else is Regular."""
    text = str(value or "").strip().lower()
    return next((c for c in GUEST_CATEGORIES if c.lower() == text), "Regular")


def clean_table(value: Any = "") -> str:
    return str(value if value is not None else "").strip()[:MAX_TABLE_LENGTH]


def norm_phone(phone: str | None) -> str:
    """Digits only, a leading 0 read as Indonesia's 62 — so ``0812…`` and ``+62 812…`` match."""
    digits = re.sub(r"\D", "", phone or "")
    return f"62{digits[1:]}" if digits.startswith("0") else digits


def norm_email(email: str | None) -> str:
    return (email or "").strip().lower()


def is_email(value: str | None) -> bool:
    return bool(_EMAIL.match((value or "").strip()))


class GuestLike(Protocol):
    #: ``norm_phone(phone)`` as stored — the value the one-guest-per-phone index holds.
    @property
    def phone_norm(self) -> str: ...
    @property
    def email(self) -> str: ...
    @property
    def rsvp(self) -> Any: ...


def match_guest[G: GuestLike](guests: Iterable[G], *, phone: str, email: str) -> G | None:
    """The guest an RSVP belongs to, among one event's guests.

    The phone decides first. An email only claims a guest who has not replied yet, and only
    when exactly one such guest has it: a couple or an office sharing one inbox must not
    overwrite each other's replies. Anyone else (a forwarded link) becomes a new guest.
    """
    mine = list(guests)
    p, e = norm_phone(phone), norm_email(email)
    if p:
        by_phone = next((g for g in mine if g.phone_norm == p), None)
        if by_phone is not None:
            return by_phone
    if not e:
        return None
    by_email = [g for g in mine if norm_email(g.email) == e and not g.rsvp]
    return by_email[0] if len(by_email) == 1 else None


def clamp_pax(pax: Any, max_pax: int) -> int:
    try:
        n = int(pax)
    except (TypeError, ValueError):
        n = 1
    return min(max(1, n), min(max_pax, MAX_PAX_LIMIT))


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------


def parse_iso_date(value: Any) -> date | None:
    """A real calendar date from ``YYYY-MM-DD`` (refuses '', '2026-02-30', …)."""
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def default_rsvp_deadline(event_date: date, today: date) -> date:
    """A week before — or the day itself for an event less than a week out, so a new event
    is never born with RSVPs already closed."""
    week_before = event_date - timedelta(days=7)
    return week_before if week_before >= today else event_date


def rsvp_open(*, published: bool, deadline: date, event_date: date, today: date) -> bool:
    """RSVPs close at the end of the deadline day and never reopen after the event."""
    return published and today <= deadline and today <= event_date


# ---------------------------------------------------------------------------
# Custom RSVP questions (R7)
# ---------------------------------------------------------------------------

QUESTION_TYPES = {"text": "Short text", "choice": "Multiple choice", "dropdown": "Dropdown"}
MAX_QUESTIONS = 10
MAX_ANSWER_LENGTH = 500
MAX_OPTIONS = 20


class QuestionLike(Protocol):
    @property
    def key(self) -> str: ...
    @property
    def label(self) -> str: ...
    @property
    def type(self) -> str: ...
    @property
    def options(self) -> list[str]: ...
    @property
    def multi(self) -> bool: ...
    @property
    def required(self) -> bool: ...
    @property
    def attending_only(self) -> bool: ...


def clean_options(options: Iterable[Any]) -> list[str]:
    """Trimmed, de-duplicated (first wins), never blank, at most 20."""
    seen: dict[str, None] = {}
    for o in options:
        text = str(o).strip()[:100]
        if text:
            seen.setdefault(text, None)
    return list(seen)[:MAX_OPTIONS]


def questions_for[Q: QuestionLike](questions: Sequence[Q], attending: bool | None) -> list[Q]:
    """What a guest is asked, given their reply. A blank question, or a choice with fewer
    than two options, is not ready and is skipped."""
    return [
        q
        for q in questions
        if q.label.strip()
        and (q.type == "text" or len(q.options) >= 2)
        and (attending is True or not q.attending_only)
    ]


def _empty(value: Any) -> bool:
    return len(value) == 0 if isinstance(value, list) else not str(value or "").strip()


def clean_answers(
    questions: Sequence[QuestionLike], attending: bool | None, raw: Mapping[str, Any] | None
) -> tuple[dict[str, Any], list[str]]:
    """``(answers, missing)``: answers to the questions this guest is asked, options that do
    not exist dropped, one value unless the question allows several, text trimmed and capped.
    ``missing`` names the required questions left empty (by label)."""
    raw = raw or {}
    answers: dict[str, Any] = {}
    missing: list[str] = []
    for q in questions_for(questions, attending):
        value = raw.get(q.key)
        if q.type == "text":
            # Only text (or a number typed into it) is an answer; a list or an object is not.
            if isinstance(value, str):
                text = value
            elif isinstance(value, int | float) and not isinstance(value, bool):
                text = str(value)
            else:
                text = ""
            value = text.strip()[:MAX_ANSWER_LENGTH]
        else:
            listed = value if isinstance(value, list) else ([value] if value else [])
            picked = [o for o in listed if isinstance(o, str) and o in q.options]
            if q.type == "choice" and q.multi:
                value = list(dict.fromkeys(picked))
            else:
                value = picked[0] if picked else ""
        if _empty(value):
            if q.required:
                missing.append(q.label.strip())
        else:
            answers[q.key] = value
    return answers, missing


def answer_counts(question: QuestionLike, guests: Iterable[Any]) -> tuple[dict[str, int], int]:
    """How often each option was picked by guests attending — the catering numbers — and how
    many attending guests gave no answer."""
    counts = {o: 0 for o in question.options}
    none = 0
    for g in guests:
        if g.rsvp != "Attending":
            continue
        value = (g.answers or {}).get(question.key)
        listed = value if isinstance(value, list) else ([value] if value else [])
        picked = [o for o in listed if isinstance(o, str) and o in counts]
        if not picked:
            none += 1
        for o in picked:
            counts[o] += 1
    return counts, none


# ---------------------------------------------------------------------------
# Checkpoints (R1)
# ---------------------------------------------------------------------------


def checkpoint_admits(categories: Sequence[str], guest_category: str) -> bool:
    """An empty category list means everyone."""
    return not categories or guest_category in categories


# ---------------------------------------------------------------------------
# Reports (BRD §4.5)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EventStats:
    invited: int
    attending: int
    declined: int
    no_response: int
    pax: int
    allergies: int
    off_list: int
    checked_in: int
    walk_ins: int


def event_stats(guests: Sequence[Any]) -> EventStats:
    attending = [g for g in guests if g.rsvp == "Attending"]
    return EventStats(
        invited=sum(1 for g in guests if g.on_master_list),
        attending=len(attending),
        declined=sum(1 for g in guests if g.rsvp == "Declined"),
        no_response=sum(1 for g in guests if g.on_master_list and not g.rsvp and not g.walk_in),
        pax=sum(g.pax or 1 for g in attending),
        allergies=sum(1 for g in attending if g.allergies),
        off_list=sum(1 for g in guests if not g.on_master_list and not g.walk_in),
        checked_in=sum(1 for g in guests if g.checked_in_at),
        walk_ins=sum(1 for g in guests if g.walk_in),
    )


def reconcile(guests: Sequence[Any]) -> dict[str, list[Any]]:
    """The four cells of the post-event grid: RSVP'd yes or not, × came or not."""
    yes = [g for g in guests if g.rsvp == "Attending"]
    no = [g for g in guests if g.rsvp != "Attending"]
    return {
        "rsvp_came": [g for g in yes if g.checked_in_at],
        "rsvp_no_show": [g for g in yes if not g.checked_in_at],
        "no_rsvp_came": [g for g in no if g.checked_in_at],
        "no_rsvp_no_show": [g for g in no if not g.checked_in_at],
    }


# ---------------------------------------------------------------------------
# Links and the guest-list CSV
# ---------------------------------------------------------------------------

_SAFE_LINK = re.compile(r"^https?://[^\s\"'<>]+$", re.IGNORECASE)


def safe_link(url: str | None) -> str:
    """http(s) links only — never ``javascript:`` — or ''."""
    text = (url or "").strip()
    return text if _SAFE_LINK.match(text) else ""


@dataclass(frozen=True, slots=True)
class CsvGuest:
    name: str
    phone: str
    email: str
    table: str
    category: str


def read_guest_csv(text: str) -> tuple[list[CsvGuest], int]:
    """The client's guest list, and how many data rows the file had (so an import can say
    how many it could not read). Columns by header (name, phone, email, table, category —
    any order, any case); without a header row, that order is assumed. Quoted cells may hold
    the separator. Excel in an Indonesian locale saves with semicolons, so whichever of ``;``
    and ``,`` the first line has more of is the separator. Rows without a name and phone go.
    """
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return [], 0
    sep = ";" if lines[0].count(";") > lines[0].count(",") else ","
    # Line by line, as the prototype parses: an unclosed quote spoils its own row only,
    # rather than swallowing every row after it.
    rows = [
        [cell.strip() for cell in next(csv.reader([line], delimiter=sep), [])] for line in lines
    ]
    head = [h.lower() for h in rows[0]]
    has_header = "name" in head or "phone" in head

    def col(name: str, fallback: int) -> int:
        if not has_header:
            return fallback
        return head.index(name) if name in head else -1

    idx = {
        "name": col("name", 0),
        "phone": col("phone", 1),
        "email": col("email", 2),
        "table": col("table", 3),
        "category": col("category", 4),
    }

    def cell(row: list[str], key: str) -> str:
        i = idx[key]
        return row[i] if 0 <= i < len(row) else ""

    data = rows[1 if has_header else 0 :]
    out = []
    for r in data:
        g = CsvGuest(
            name=cell(r, "name"),
            phone=cell(r, "phone"),
            email=cell(r, "email"),
            table=cell(r, "table"),
            category=to_category(cell(r, "category")),
        )
        if g.name and g.phone:
            out.append(g)
    return out, len(data)


def parse_guest_csv(text: str) -> list[CsvGuest]:
    return read_guest_csv(text)[0]


# ---------------------------------------------------------------------------
# Invitation content (Invitations v2)
# ---------------------------------------------------------------------------


def blank_content(
    *, name: str = "", date_: str = "", time: str = "", venue: str = ""
) -> dict[str, Any]:
    """Every section's content, empty. Lists start empty so an untouched section stays hidden."""
    return {
        "cover": {"eyebrow": "You are invited", "title": name, "subtitle": "", "image": None},
        "message": {"body": "We would be delighted to have you with us."},
        "couple": {
            "a": {"name": "", "parents": "", "photo": None, "ig": ""},
            "b": {"name": "", "parents": "", "photo": None, "ig": ""},
        },
        "hosts": {"names": "", "logos": []},
        "countdown": {},
        "details": {
            "name": "",
            "date": date_,
            "time": time,
            "venue": venue,
            "mapUrl": "",
            "sessions": [],
        },
        "agenda": {"rows": []},
        "speakers": {"people": []},
        "story": {"items": []},
        "dresscode": {"text": ""},
        "gallery": {"photos": []},
        "video": {"kind": "link", "url": "", "file": None},
        "music": {"kind": "builtin", "trackId": "soft-piano", "file": None},
        "rsvp": {},
        "wishes": {},
        "gift": {"accounts": [], "address": ""},
    }


def _s(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def has_content(section_id: str, c: Mapping[str, Any]) -> bool:
    """Does a section have anything to show? An empty one is skipped on the guest page."""

    def get(*path: str) -> Any:
        cur: Any = c
        for p in path:
            cur = cur.get(p) if isinstance(cur, Mapping) else None
        return cur

    def rows(*path: str) -> list[Any]:
        v = get(*path)
        return [x for x in v if isinstance(x, Mapping)] if isinstance(v, list) else []

    match section_id:
        case "message":
            return bool(_s(get("message", "body")))
        case "couple":
            return bool(_s(get("couple", "a", "name")) or _s(get("couple", "b", "name")))
        case "hosts":
            return bool(_s(get("hosts", "names")) or get("hosts", "logos"))
        case "agenda":
            return any(_s(r.get("label")) for r in rows("agenda", "rows"))
        case "speakers":
            return any(_s(p.get("name")) for p in rows("speakers", "people"))
        case "story":
            return any(_s(s.get("title")) or _s(s.get("text")) for s in rows("story", "items"))
        case "dresscode":
            return bool(_s(get("dresscode", "text")))
        case "gallery":
            return bool(get("gallery", "photos"))
        case "video":
            if get("video", "kind") == "upload":
                return bool(get("video", "file"))
            return bool(_s(get("video", "url")))
        case "gift":
            return any(_s(a.get("number")) for a in rows("gift", "accounts")) or bool(
                _s(get("gift", "address"))
            )
        case "countdown":
            return bool(get("details", "date"))
        case _:
            return True  # cover, details, rsvp, wishes


def visible_sections(
    template: Mapping[str, Any] | None,
    toggles: Mapping[str, Any],
    content: Mapping[str, Any],
    *,
    include_empty: bool = False,
) -> list[str]:
    """The sections a renderer draws, in the template's order."""
    if template is None:
        return []
    return [
        s
        for s in template["sections"]
        if section_on(template, toggles, s) and (include_empty or has_content(s, content))
    ]


#: How much each list may hold, so a pasted spreadsheet cannot swamp the page.
LIST_LIMITS = {
    "photos": 12,
    "logos": 6,
    "people": 12,
    "rows": 30,
    "items": 10,
    "sessions": 4,
    "accounts": 4,
}
_DEFAULT_LIST_LIMIT = 50
_TEXT_MAX = 300
_LONG_TEXT_MAX = 2000
_LONG_TEXT = frozenset({"body", "text", "address"})
_MEDIA_KEYS = frozenset({"image", "photo", "photos", "logos", "file"})
_MAX_DEPTH = 6
#: Cleaned, serialised. Text caps keep a real section to a few kilobytes.
MAX_SECTION_BYTES = 64 * 1024


class ContentTooLarge(ValueError):
    pass


def _file_ref(v: Mapping[str, Any]) -> dict[str, Any] | None:
    key = v.get("key")
    if not isinstance(key, str) or not key or len(key) > 200:
        return None
    try:
        size = int(v.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    return {
        "key": key,
        "name": str(v.get("name") or "")[:120],
        "size": max(0, size),
        "type": str(v.get("type") or "")[:100],
    }


def clean_section(value: Any) -> Any:
    """One section's content as saved: strings capped, lists capped, and media fields holding
    only a stored-file reference or nothing. Links are kept as typed — the page checks them
    when drawing (``safe_link``), so a half-typed "htt…" is not wiped mid-edit.

    Raises ``ContentTooLarge`` past the depth or size bound."""

    def walk(v: Any, key: str, depth: int) -> Any:
        if depth > _MAX_DEPTH:
            raise ContentTooLarge("That section is nested too deeply.")
        if key in _MEDIA_KEYS and isinstance(v, str):
            return None  # inline images are browser-only; the server keeps file references
        if isinstance(v, str):
            return v[: _LONG_TEXT_MAX if key in _LONG_TEXT else _TEXT_MAX]
        if isinstance(v, list):
            items = [
                walk(x, key, depth + 1) for x in v[: LIST_LIMITS.get(key, _DEFAULT_LIST_LIMIT) * 2]
            ]
            if key in _MEDIA_KEYS:
                items = [x for x in items if x]
            return items[: LIST_LIMITS.get(key, _DEFAULT_LIST_LIMIT)]
        if isinstance(v, Mapping):
            if "key" in v and "size" in v:
                return _file_ref(v)
            return {str(k)[:40]: walk(x, str(k), depth + 1) for k, x in list(v.items())[:40]}
        if isinstance(v, bool | int | float) or v is None:
            return v
        return None

    cleaned = walk(value, "", 0)
    if len(json.dumps(cleaned, ensure_ascii=False).encode()) > MAX_SECTION_BYTES:
        raise ContentTooLarge("That section is too large to save.")
    return cleaned


# ---------------------------------------------------------------------------
# Wishes (D13)
# ---------------------------------------------------------------------------

#: How long a wish may be, and how many one guest (or one name, off the list) may leave.
WISH_TEXT_MAX = 500
WISH_NAME_MAX = 80
WISHES_PER_GUEST = 3
WISHES_PER_EVENT = 500


def wish_visible(*, hidden: bool, approved: bool, hold: bool) -> bool:
    """Not hidden, and — while the event holds wishes for approval — approved."""
    return not hidden and (not hold or approved)


def wish_state(
    *, hidden: bool, approved: bool, hold: bool
) -> Literal["shown", "waiting", "hidden"]:
    """For the moderation list: shown | waiting | hidden."""
    if hidden:
        return "hidden"
    return "waiting" if hold and not approved else "shown"


def walkin_open(*, event_date: date, today: date) -> bool:
    """The walk-in desk is only open around the event: from the day before to the day after.
    A desk link from a past or far-off event is no use to anyone."""
    return event_date - timedelta(days=1) <= today <= event_date + timedelta(days=1)
