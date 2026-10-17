"""Operator-edited lines on a payment or receipt, and the guard that makes them safe.

Round 4 of the client's feedback reversed an earlier decision (REQ-05 v1 kept posting lines
read-only and pointed at **Adjust** for corrections): the confirmation dialog now lets the
operator change the lines of the money entry before it posts — split the cash across two
accounts, move the withholding, add a bank charge.

What may change is deliberately narrow, and this module is where that is enforced:

* **Only the payment/receipt entry.** The companion accruals an operation also posts — the
  down-payment invoice, the vendor bill, a settlement variance — are never replaced. They
  are computed from the document, and an edited invoice entry would stop being the invoice.
* **The control account moves by exactly what was computed.** 1201 for client money, 2102
  for vendor money. That figure is what settles the open item (`applied_to` links the
  entry; open-item ageing measures the movement on the control account), so a different
  amount would leave the invoice or bill half-settled, or settled past zero, while the
  dialog claimed otherwise. The locked side is the only side: no contra line on the
  control account that nets back to the right figure.
* **No line on the other control account.** A client receipt may not touch 2102, a vendor
  payment may not touch 1201, and neither may touch a sub-account of either (the chart
  refuses those, but older data could hold one). AR and AP open items are reconciled
  against exactly those two accounts; a "Dr 1201 / Cr 1101" slipped into a vendor payment
  would move the receivable balance with no invoice behind it.
* Every account exists, is active, and is not a header; every line is one-sided and
  non-negative; debits equal credits.

All refusals are 422, because each one is a malformed request rather than a state conflict.
The posting engine and the database trigger still enforce balance and closed periods
independently — this is the early, human-readable check, not the only one.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid
from app.core.money import ZERO, money
from app.domain.accounts.models import Account, control_account_of
from app.domain.ledger.posting import LineIn, _normalise


class SubmittedLine(Protocol):
    account: str
    debit: Decimal
    credit: Decimal
    note: str | None


def net_movement(lines: Sequence[LineIn], account: str) -> Decimal:
    """Debit minus credit on one account across a set of lines."""
    return money(
        sum(
            ((ln.debit or ZERO) - (ln.credit or ZERO) for ln in lines if ln.account == account),
            start=ZERO,
        )
    )


def _describe(movement: Decimal) -> str:
    if movement > ZERO:
        return f"a debit of {movement}"
    if movement < ZERO:
        return f"a credit of {-movement}"
    return "no movement"


async def apply_line_override(
    session: AsyncSession,
    *,
    computed: list[LineIn],
    submitted: Sequence[SubmittedLine] | None,
    control: str,
) -> list[LineIn]:
    """Return the lines to post: ``computed`` unchanged, or ``submitted`` once guarded."""
    if submitted is None:
        return computed

    lines = [
        LineIn(account=(ln.account or "").strip(), debit=ln.debit, credit=ln.credit, note=ln.note)
        for ln in submitted
    ]
    # Two or more lines, an account on each, one side per line, no negatives, no empty line.
    normalised = _normalise(lines)

    for ln in normalised:
        if control_account_of(ln.account) is not None and ln.account != control:
            raise Invalid(
                f"The edited lines post to {ln.account}, a receivable/payable control "
                f"account. Only the locked {control} line may touch a control account "
                "here: a line on the other one would move open items with no document "
                "behind them. Remove that line."
            )

    expected = net_movement(computed, control)
    got = net_movement(normalised, control)
    # A contra line (a Dr 1201 beside the Cr 1201 it nets against) would pass the net check
    # while scrambling the open items, so the locked side is the only side.
    contra = any(
        ln.account == control
        and ((ln.debit or ZERO) if expected < ZERO else (ln.credit or ZERO)) > ZERO
        for ln in normalised
    )
    if got != expected or contra:
        raise Invalid(
            f"The edited lines give control account {control} {_describe(got)}, but this "
            f"payment must post {_describe(expected)} there. That line is locked: it is "
            "what settles the invoice or bill. Change the amount being paid instead."
        )

    debit = sum((ln.debit for ln in normalised), start=ZERO)
    credit = sum((ln.credit for ln in normalised), start=ZERO)
    if debit != credit:
        raise Invalid(
            f"The edited lines do not balance: debits {debit}, credits {credit} — out by "
            f"{abs(debit - credit)}."
        )

    codes = sorted({ln.account for ln in normalised})
    found = {
        a.code: a
        for a in (
            await session.execute(select(Account).where(Account.code.in_(codes)))
        ).scalars()
    }
    missing = [c for c in codes if c not in found]
    if missing:
        raise Invalid(f"Unknown account code(s) in the edited lines: {', '.join(missing)}.")

    headers = set(
        (
            await session.execute(
                select(Account.parent_code).where(Account.parent_code.in_(codes)).distinct()
            )
        )
        .scalars()
        .all()
    )
    for code in codes:
        if code in headers:
            raise Invalid(
                f"Account {code} ({found[code].name}) is a header with sub-accounts and "
                "does not accept postings. Choose one of its sub-accounts."
            )
        if not found[code].active:
            raise Invalid(
                f"Account {code} ({found[code].name}) is deactivated and does not accept "
                "postings. Choose another account."
            )

    return normalised
