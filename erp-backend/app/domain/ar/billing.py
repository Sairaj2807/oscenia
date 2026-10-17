"""Phased down-payment schedules.

Ported from ``erp-frontend/src/lib/billing.js``. The client asked for DP requests
"configured flexibly and in phases according to negotiation agreements": standard presets
of 50 / 75 / 100 percent, plus fully custom percentages or nominal amounts.

**The schedule must bill the contract to the rupiah.** Percentages of an awkward contract
value do not divide evenly, so the final stage absorbs the rounding remainder — that is
``allocate()`` in ``app.core.money``, and ``verify-flows.mjs`` §47 asserts it for every
preset and for deliberately awkward values.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from app.core.errors import Invalid
from app.core.money import ZERO, allocate, money
from app.domain.ar.models import InvoiceType, StageAnchor, StageBasis


@dataclass(slots=True)
class StageSpec:
    """One stage as configured, before it meets a contract value."""

    label: str
    basis: StageBasis
    value: Decimal
    anchor: StageAnchor = StageAnchor.SIGNING
    offset_days: int = 0


@dataclass(slots=True)
class ResolvedStage:
    """One stage after resolution: a real amount and a real due date."""

    stage_no: int
    label: str
    basis: StageBasis
    value: Decimal
    anchor: StageAnchor
    offset_days: int
    amount: Decimal
    due: date | None
    percent: Decimal
    invoice_type: InvoiceType


PRESETS: dict[str, tuple[str, list[StageSpec]]] = {
    "50": (
        "50%",
        [
            StageSpec("Down Payment", StageBasis.PERCENT, Decimal(50), StageAnchor.SIGNING, 0),
            StageSpec("Final Settlement", StageBasis.PERCENT, Decimal(50), StageAnchor.EVENT, -7),
        ],
    ),
    "75": (
        "75%",
        [
            StageSpec("Down Payment", StageBasis.PERCENT, Decimal(75), StageAnchor.SIGNING, 0),
            StageSpec("Final Settlement", StageBasis.PERCENT, Decimal(25), StageAnchor.EVENT, -7),
        ],
    ),
    "100": (
        "100%",
        [
            StageSpec("Full Payment", StageBasis.PERCENT, Decimal(100), StageAnchor.SIGNING, 0),
        ],
    ),
    "staged": (
        "30 / 40 / 30",
        [
            StageSpec("Down Payment", StageBasis.PERCENT, Decimal(30), StageAnchor.SIGNING, 0),
            StageSpec(
                "Production Milestone", StageBasis.PERCENT, Decimal(40), StageAnchor.EVENT, -30
            ),
            StageSpec("Final Settlement", StageBasis.PERCENT, Decimal(30), StageAnchor.EVENT, 7),
        ],
    ),
}


def preset_stages(key: str) -> list[StageSpec]:
    if key not in PRESETS:
        raise Invalid(f"Unknown down-payment preset {key!r}. Choose one of {sorted(PRESETS)}.")
    return [
        StageSpec(s.label, s.basis, s.value, s.anchor, s.offset_days) for s in PRESETS[key][1]
    ]


def stage_invoice_type(index: int, count: int) -> InvoiceType:
    """First stage is the down payment, last is the settlement, anything between is progress.

    A single-stage schedule is a full payment up front, which is still a down payment as
    far as revenue account 4101 is concerned.
    """
    if index == 0:
        return InvoiceType.DOWN_PAYMENT
    if index == count - 1:
        return InvoiceType.FINAL
    return InvoiceType.PROGRESS


def validate(stages: list[StageSpec], contract_value: Decimal) -> None:
    """Refuse a schedule that does not add up to the contract.

    A schedule that bills 90% of the job is not a rounding problem, it is a missing stage —
    and the prototype blocks submission on it rather than quietly under-billing.
    """
    if not stages:
        raise Invalid("A billing schedule needs at least one stage.")

    for stage in stages:
        if stage.value < ZERO:
            raise Invalid(f"Stage {stage.label!r} has a negative value.")
        if not stage.label.strip():
            raise Invalid("Every billing stage needs a label.")

    percent_total = sum(
        (s.value for s in stages if s.basis is StageBasis.PERCENT), start=Decimal(0)
    )
    amount_total = sum(
        (s.value for s in stages if s.basis is StageBasis.AMOUNT), start=Decimal(0)
    )

    if amount_total == ZERO:
        if percent_total != Decimal(100):
            raise Invalid(
                f"The stages total {percent_total}% of the contract, not 100%. "
                "Adjust a stage or use the balance-to-contract action."
            )
        return

    # Mixed or amount-only: the fixed amounts plus the percentage share must equal the
    # contract exactly.
    implied = money(amount_total + contract_value * percent_total / Decimal(100))
    if implied != money(contract_value):
        raise Invalid(
            f"The stages total {implied}, but the contract is {money(contract_value)} — "
            f"out by {abs(implied - money(contract_value))}."
        )


def resolve(
    stages: list[StageSpec],
    contract_value: Decimal,
    *,
    signing_date: date,
    event_date: date | None = None,
) -> list[ResolvedStage]:
    """Turn configured stages into billable amounts and due dates.

    Percentage stages are allocated so the parts sum to the contract **exactly**; the last
    one absorbs the remainder. Fixed-amount stages are taken at face value and the
    percentage stages share what is left, which is what makes a mixed schedule work.
    """
    validate(stages, contract_value)
    contract = money(contract_value)

    fixed = {
        i: money(s.value) for i, s in enumerate(stages) if s.basis is StageBasis.AMOUNT
    }
    remainder = contract - sum(fixed.values(), start=ZERO)

    percent_indices = [i for i, s in enumerate(stages) if s.basis is StageBasis.PERCENT]
    shares = allocate(remainder, [stages[i].value for i in percent_indices])
    allocated = dict(zip(percent_indices, shares, strict=True))

    resolved: list[ResolvedStage] = []
    for index, stage in enumerate(stages):
        amount = fixed.get(index, allocated.get(index, ZERO))
        resolved.append(
            ResolvedStage(
                stage_no=index + 1,
                label=stage.label.strip(),
                basis=stage.basis,
                value=stage.value,
                anchor=stage.anchor,
                offset_days=stage.offset_days,
                amount=amount,
                due=_due(stage, signing_date, event_date),
                percent=(
                    (amount / contract * Decimal(100)).quantize(Decimal("0.01"))
                    if contract
                    else ZERO
                ),
                invoice_type=stage_invoice_type(index, len(stages)),
            )
        )
    return resolved


def _due(stage: StageSpec, signing_date: date, event_date: date | None) -> date | None:
    """Anchor plus a signed offset. Negative means before the anchor."""
    anchor = signing_date if stage.anchor is StageAnchor.SIGNING else event_date
    if anchor is None:
        # An event-anchored stage on a quotation with no event date has no due date yet.
        # Better an honest null than a date invented from today.
        return None
    return anchor + timedelta(days=stage.offset_days)


def total(resolved: list[ResolvedStage]) -> Decimal:
    return money(sum((s.amount for s in resolved), start=ZERO))
