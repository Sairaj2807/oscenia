"""Money policy: exact decimals, and the one materiality threshold.

Two thresholds live here and they are *not* the same thing. The prototype conflated them
into a single ``EPSILON = 1`` (``src/lib/ledger.js:27``), which was doing two jobs:

1. **Balance tolerance** — a float guard, because JavaScript numbers are inexact.
   ``Decimal`` is exact, so this is obsolete. Entries balance to precisely ``0.00``.

2. **Materiality** — a business rule. A document with under Rp 1 outstanding counts as
   settled (``ledger.js:274, 295``); a statement line worth under Rp 1 is not printed
   (``ledger.js:337, 410, 443``). This survives, named, because dropping it would leave
   the AR list showing rounding dust as open receivables.

See docs/finance-backend/03-accounting-rules.md#money-and-materiality.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal

#: Two decimal places, as NUMERIC(18,2) and as the client's "2-decimal precision" ask.
CENTS = Decimal("0.01")
ZERO = Decimal("0.00")

#: One rupiah. Below this, a balance is not worth chasing and a line is not worth printing.
#: This is a business rule, never a float guard.
MATERIALITY = Decimal("1.00")


def money(value: Decimal | int | str) -> Decimal:
    """Coerce to the canonical money scale, rounding half-up.

    Half-up rather than banker's rounding because that is what the prototype does
    (``Math.round``) and what an Indonesian finance team expects on a tax line.
    """
    return Decimal(value).quantize(CENTS, rounding=ROUND_HALF_UP)


def is_material(value: Decimal) -> bool:
    """True when an amount is large enough to matter."""
    return abs(value) >= MATERIALITY


def is_immaterial(value: Decimal) -> bool:
    return not is_material(value)


def percent_of(base: Decimal, rate: Decimal | int | str) -> Decimal:
    """``base × rate%``, rounded once at the end.

    Used for withholding tax and down-payment percentages. Rounding happens here, at the
    point the figure is computed — never during accumulation.
    """
    return money(base * Decimal(rate) / Decimal(100))


def allocate(total: Decimal, weights: Sequence[Decimal]) -> list[Decimal]:
    """Split ``total`` across ``weights`` so the parts sum to it exactly.

    The final part absorbs the rounding remainder. Two places depend on this:

    * **billing schedules** — a phased DP schedule must bill the contract to the rupiah
      (``verify-flows.mjs`` §47 asserts this for every preset and for awkward values)
    * **depreciation** — accumulated depreciation must land exactly on ``cost - salvage``
      and never a cent past it (§53)

    A zero total, or weights summing to zero, yields zeros rather than raising — a
    contract of nothing is legitimately billed as nothing.
    """
    if not weights:
        return []

    weight_total = sum(weights, start=Decimal(0))
    if weight_total == 0:
        return [ZERO for _ in weights]

    parts = [money(total * w / weight_total) for w in weights[:-1]]
    parts.append(money(total) - sum(parts, start=ZERO))
    return parts


def split_evenly(total: Decimal, count: int) -> list[Decimal]:
    """``total`` in ``count`` equal parts, the last absorbing the remainder."""
    if count <= 0:
        return []
    return allocate(total, [Decimal(1)] * count)
