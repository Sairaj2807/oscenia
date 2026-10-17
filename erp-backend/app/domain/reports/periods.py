"""Named reporting periods, resolved server-side.

The client sends ``period=quarter``; the server decides what that means. Two reasons:

* the browser's clock and timezone are not the company's, and "this month" must mean the
  Jakarta month (see ``app.core.clock``)
* the quarter boundary must be **derived**, never hardcoded. The prototype had a literal
  July in it, which quietly returned the wrong window for three quarters of the year.
"""

from __future__ import annotations

import calendar
import enum
from datetime import date

from app.core.errors import Invalid
from app.domain.reports.queries import Period


class NamedPeriod(enum.StrEnum):
    TODAY = "today"
    MONTH = "month"
    QUARTER = "quarter"
    YTD = "ytd"
    ALL = "all"
    CUSTOM = "custom"


def month_end(year: int, month: int) -> date:
    """Last calendar day of a month — leap years included."""
    return date(year, month, calendar.monthrange(year, month)[1])


def quarter_start(on: date) -> date:
    """First day of the quarter containing ``on``.

    Derived from the month, so it is correct in every quarter rather than the one someone
    happened to test in.
    """
    first_month = 3 * ((on.month - 1) // 3) + 1
    return date(on.year, first_month, 1)


def resolve_period(
    named: NamedPeriod,
    today: date,
    *,
    start: date | None = None,
    end: date | None = None,
) -> Period:
    if named is NamedPeriod.CUSTOM or (start is not None or end is not None):
        if start is not None and end is not None and start > end:
            raise Invalid(f"The period starts ({start}) after it ends ({end}).")
        return Period(start=start, end=end)

    if named is NamedPeriod.TODAY:
        return Period(start=today, end=today)
    if named is NamedPeriod.MONTH:
        return Period(
            start=date(today.year, today.month, 1),
            end=month_end(today.year, today.month),
        )
    if named is NamedPeriod.QUARTER:
        first = quarter_start(today)
        last_month = first.month + 2
        return Period(start=first, end=month_end(first.year, last_month))
    if named is NamedPeriod.YTD:
        return Period(start=date(today.year, 1, 1), end=today)

    return Period()
