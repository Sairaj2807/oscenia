"""The relationship rules: when to get in touch with a client.

A port of ``usualMonth``, ``nextNudge``, ``isMonthDay``, ``nextOccurrence`` and
``relationshipCalendar`` from the prototype's ``lib/crm.js``. They are pure functions of dates and
plain values, tested against the prototype's own answers
(``tests/fixtures/crm_relations_matrix.json``, written by
``erp-frontend/scripts/gen-crm-fixture.mjs``), so the server and the screen agree on what
"nudge Company A in April" means.

Dates are ISO strings (``YYYY-MM-DD``), as in the prototype, because that is what the comparison
rules below are written against: the string order of an ISO date is its calendar order.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from typing import Any

MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_DAYS_IN = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)  # February at its longest
_MONTH_DAY = re.compile(r"^(\d{2})-(\d{2})$")

KIND_NUDGE = "Event nudge"
KIND_BIRTHDAY = "Birthday"
KIND_ANNIVERSARY = "Company anniversary"


def month_name(month: int) -> str:
    return MONTH_NAMES[month - 1]


def usual_month(history: Iterable[str]) -> int | None:
    """The month a recurring event usually runs: the most frequent in its history, the earlier month
    on a tie. ``None`` for no history."""
    count = Counter(int(ym[5:7]) for ym in history)
    if not count:
        return None
    return sorted(count.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def _iso(year: int, month: int, day: int = 1) -> str:
    return f"{year:04d}-{month:02d}-{day:02d}"


def next_nudge(history: Sequence[str], lead_months: int, today: str) -> dict[str, Any] | None:
    """The next edition not yet booked, and the day to nudge the client about it: ``lead_months``
    before the start of its usual month ("gathers every July, call in April").

    A year counts as booked if the event ran, or is booked, at all that year: an edition moved from
    August to September is still that year's edition.
    """
    month = usual_month(history)
    if month is None:
        return None
    booked_years = {int(h[:4]) for h in history}
    this_year, this_month = int(today[:4]), int(today[5:7])
    floor = _iso(this_year, this_month)
    year = this_year
    while year in booked_years or _iso(year, month) < floor:
        year += 1
    # Months before January roll back into earlier years, the way Date.UTC does.
    index = year * 12 + (month - 1 - lead_months)
    nudge_on = _iso(index // 12, index % 12 + 1)
    return {"month": month, "edition": f"{year:04d}-{month:02d}", "nudge_on": nudge_on}


def is_month_day(value: object) -> bool:
    """``MM-DD`` that exists on a calendar: 29 February is allowed, 31 April is not."""
    if not isinstance(value, str):
        return False
    found = _MONTH_DAY.match(value)
    if not found:
        return False
    month, day = int(found.group(1)), int(found.group(2))
    if not 1 <= month <= 12:
        return False
    return 1 <= day <= _DAYS_IN[month - 1]


def _leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def next_occurrence(month_day: str, today: str) -> str:
    """``MM-DD`` or ``YYYY-MM-DD`` -> the next date on or after ``today`` it falls on. A 29 February
    in a year without one is kept on the 28th."""
    md = month_day[5:] if len(month_day) == 10 else month_day

    def on(year: int) -> str:
        if md == "02-29" and not _leap(year):
            return f"{year}-02-28"
        return f"{year}-{md}"

    year = int(today[:4])
    return on(year) if on(year) >= today else on(year + 1)


def days_between(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def greeting_text(kind: str, *, client: str, title: str) -> str:
    """The message a greeting starts from. For an anniversary ``title`` is ``"<n> years …"``."""
    if kind == KIND_BIRTHDAY:
        return (
            f"Happy birthday, {title}! Wishing you a wonderful year ahead — "
            "from all of us at Oscenia Events."
        )
    years = title.split(" ")[0]
    return (
        f"Happy anniversary to everyone at {client}! "
        f"Thank you for {years} years of celebrating with Oscenia Events."
    )


def relationship_calendar(
    clients: Sequence[Mapping[str, Any]],
    relations: Mapping[str, Mapping[str, Any]],
    today: str,
    days: int = 90,
) -> list[dict[str, Any]]:
    """Everything worth a call or a message in the next ``days`` days: event-cycle nudges (overdue
    ones included, they are the most urgent), PIC birthdays and company anniversaries, soonest
    first.

    ``clients`` carry ``id`` and ``name``; ``relations`` maps a client id to
    ``{nudgeLeadMonths, cycles: [{name, history}], handledNudges,
    pics: [{id, name, role, birthday}], anniversary}`` (camelCase, as the prototype's store keeps
    it, so one fixture serves both).
    """
    items: list[dict[str, Any]] = []
    for client in clients:
        rel = relations.get(client["id"])
        if not rel:
            continue
        lead = rel.get("nudgeLeadMonths", 3)
        handled = set(rel.get("handledNudges") or [])
        for cycle in rel.get("cycles") or []:
            nudge = next_nudge(cycle["history"], lead, today)
            if nudge is None:
                continue
            key = f"{cycle['name']}:{nudge['edition']}"
            if key in handled:
                continue
            in_days = days_between(today, nudge["nudge_on"])
            if in_days <= days:
                items.append(
                    {
                        "kind": KIND_NUDGE,
                        "clientId": client["id"],
                        "client": client["name"],
                        "date": nudge["nudge_on"],
                        "inDays": in_days,
                        "key": key,
                        "title": f"{cycle['name']} {nudge['edition'][:4]}",
                        "detail": (
                            f"Usually in {month_name(nudge['month'])} — "
                            f"reach out {lead} months ahead"
                        ),
                    }
                )
        for pic in rel.get("pics") or []:
            if not pic.get("birthday"):
                continue
            on = next_occurrence(pic["birthday"], today)
            in_days = days_between(today, on)
            if in_days <= days:
                items.append(
                    {
                        "kind": KIND_BIRTHDAY,
                        "clientId": client["id"],
                        "client": client["name"],
                        "date": on,
                        "inDays": in_days,
                        "title": pic["name"],
                        "detail": pic.get("role", ""),
                        "picId": pic.get("id"),
                    }
                )
        anniversary = rel.get("anniversary")
        if anniversary:
            on = next_occurrence(anniversary, today)
            in_days = days_between(today, on)
            years = int(on[:4]) - int(anniversary[:4])
            if years >= 1 and in_days <= days:
                items.append(
                    {
                        "kind": KIND_ANNIVERSARY,
                        "clientId": client["id"],
                        "client": client["name"],
                        "date": on,
                        "inDays": in_days,
                        "title": f"{years} years with Oscenia",
                        "detail": client["name"],
                    }
                )
    return sorted(items, key=lambda item: item["date"])
