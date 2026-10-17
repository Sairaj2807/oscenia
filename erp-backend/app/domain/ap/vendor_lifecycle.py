"""The vendor lifecycle: where each supplier stands, from first contact to trading.

Prospect -> Onboarding -> Approved -> Active, with On hold and Blacklisted off to the side. Only an
Approved or Active vendor may be given a new purchase order (when ``enforce_vendor_stage`` is on).
These are the prototype's ``lib/vendors.js`` rules, word for word where the wording is shown.

Approving, holding, blacklisting and reactivating need ``approve_po`` (CEO, finance); a PM can bring
a vendor in and start onboarding, never approve one.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, PermissionDenied
from app.core.rbac import can_do
from app.domain.ap.models import (
    PoStatus,
    PurchaseOrder,
    Vendor,
    VendorAttachment,
    VendorCheck,
    VendorStageHistory,
)
from app.domain.masters.models import User

STAGES = ("Prospect", "Onboarding", "Approved", "Active")
OFF_BOARD = ("On hold", "Blacklisted")
ALL_STAGES = (*STAGES, *OFF_BOARD)
MANUAL_CHECKS = ("agreement", "reference")
ORDERABLE = ("Approved", "Active")


def can_order_from(stage: str) -> bool:
    return stage in ORDERABLE


def next_stage(stage: str) -> str | None:
    if stage in STAGES and stage != STAGES[-1]:
        return STAGES[STAGES.index(stage) + 1]
    return None


@dataclass(frozen=True, slots=True)
class ChecklistItem:
    key: str
    label: str
    done: bool
    manual: bool = False
    auto: bool = False


def _has(value: str | None) -> bool:
    return bool((value or "").strip())


def checklist(
    vendor: Vendor, checks: dict[str, bool], *, has_agreement_file: bool
) -> list[ChecklistItem]:
    """What onboarding needs before approval. Three items come from the vendor record itself;
    the agreement is ticked by a filed Agreement file or by hand; the reference check by hand."""
    return [
        ChecklistItem("npwp", "Tax ID (NPWP) recorded", _has(vendor.npwp)),
        ChecklistItem(
            "bank", "Bank account recorded", _has(vendor.bank_account) and _has(vendor.bank_holder)
        ),
        ChecklistItem(
            "pic",
            "Person in charge with a phone or email",
            _has(vendor.pic_name) and (_has(vendor.pic_phone) or _has(vendor.pic_email)),
        ),
        ChecklistItem(
            "agreement",
            "Signed agreement (MoU) on file",
            bool(checks.get("agreement")) or has_agreement_file,
            manual=True,
            auto=has_agreement_file,
        ),
        ChecklistItem(
            "reference",
            "Reference checked with a past client",
            bool(checks.get("reference")),
            manual=True,
        ),
    ]


def resume_stage(history: list[VendorStageHistory]) -> str:
    """The board stage a vendor on hold returns to: the last board stage in its history."""
    for row in reversed(history):
        if row.stage in STAGES:
            return row.stage
    return "Onboarding"


def stage_error(
    *,
    from_: str,
    to: str,
    can_approve: bool,
    checklist_complete: bool,
    has_live_po: bool,
    reason: str | None,
    resume_to: str | None,
) -> tuple[str, str] | None:
    """Why a stage change is refused, as ``(kind, message)`` with kind ``permission`` or ``rule``,
    or None when it is allowed. Pure, so every rule can be tested in a table."""
    if to not in ALL_STAGES:
        return ("rule", "Unknown stage.")
    if from_ == to:
        return ("rule", "The vendor is already there.")
    if to in OFF_BOARD:
        if not can_approve:
            return (
                "permission",
                "Only finance or the CEO can put a vendor on hold or blacklist one.",
            )
        # Lifting a blacklisting is a fresh vetting (back to Onboarding), not a softer hold.
        if from_ == "Blacklisted":
            return ("rule", "A blacklisted vendor has to be vetted again: back to Onboarding.")
        if not (reason or "").strip():
            return ("rule", "Give a reason — it stays on the vendor’s record.")
        return None
    if from_ == "On hold":
        if not can_approve:
            return ("permission", "Only finance or the CEO can reactivate a vendor.")
        want = resume_to or "Onboarding"
        return None if to == want else ("rule", f"A vendor on hold goes back to {want}.")
    if from_ == "Blacklisted":
        if not can_approve:
            return ("permission", "Only finance or the CEO can reactivate a vendor.")
        if to == "Onboarding":
            return None
        return ("rule", "A blacklisted vendor has to be vetted again: back to Onboarding.")
    if next_stage(from_) != to:
        return ("rule", "Move a vendor one stage at a time.")
    if to == "Approved":
        if not can_approve:
            return ("permission", "Only finance or the CEO can approve a vendor.")
        if not checklist_complete:
            return ("rule", "Finish the onboarding checklist first.")
    if to == "Active" and not has_live_po:
        return ("rule", "A vendor becomes active with its first approved purchase order.")
    return None


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Lifecycle:
    vendor: Vendor
    checks: dict[str, bool]
    has_agreement_file: bool
    has_live_po: bool
    history: list[VendorStageHistory]
    items: list[ChecklistItem]

    @property
    def resume_to(self) -> str | None:
        if self.vendor.stage == "On hold":
            return resume_stage(self.history)
        if self.vendor.stage == "Blacklisted":
            return "Onboarding"
        return None


async def lifecycles(
    session: AsyncSession, vendor_ids: list[uuid.UUID] | None = None
) -> list[Lifecycle]:
    """The lifecycle of every vendor (or the given ones), in a handful of queries however many."""
    stmt = select(Vendor).order_by(Vendor.vendor_no)
    if vendor_ids is not None:
        stmt = stmt.where(Vendor.id.in_(vendor_ids))
    vendors = list((await session.execute(stmt)).scalars().all())
    ids = [v.id for v in vendors]
    checks: dict[uuid.UUID, dict[str, bool]] = {}
    found = await session.execute(select(VendorCheck).where(VendorCheck.vendor_id.in_(ids)))
    for c in found.scalars():
        checks.setdefault(c.vendor_id, {})[c.key] = c.done
    agreements = set(
        (
            await session.execute(
                select(VendorAttachment.vendor_id).where(
                    VendorAttachment.vendor_id.in_(ids), VendorAttachment.kind == "Agreement"
                )
            )
        ).scalars()
    )
    live = set(
        (
            await session.execute(
                select(PurchaseOrder.vendor_id)
                .where(
                    PurchaseOrder.vendor_id.in_(ids),
                    PurchaseOrder.status.notin_([PoStatus.DRAFT, PoStatus.CANCELLED]),
                )
                .distinct()
            )
        ).scalars()
    )
    history: dict[uuid.UUID, list[VendorStageHistory]] = {}
    rows = await session.execute(
        select(VendorStageHistory)
        .where(VendorStageHistory.vendor_id.in_(ids))
        .order_by(VendorStageHistory.created_at, VendorStageHistory.id)
    )
    for h in rows.scalars():
        history.setdefault(h.vendor_id, []).append(h)
    return [
        Lifecycle(
            vendor=v,
            checks=checks.get(v.id, {}),
            has_agreement_file=v.id in agreements,
            has_live_po=v.id in live,
            history=history.get(v.id, []),
            items=checklist(v, checks.get(v.id, {}), has_agreement_file=v.id in agreements),
        )
        for v in vendors
    ]


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def _may_edit(user: User) -> bool:
    return can_do(user.role, "request_po") or can_do(user.role, "approve_po")


def start_as_prospect(session: AsyncSession, vendor: Vendor, user: User) -> None:
    """A new vendor enters the board as a Prospect, with that as the first line of its history."""
    now = datetime.now(UTC)
    vendor.stage = "Prospect"
    vendor.stage_since = now
    session.add(
        VendorStageHistory(
            vendor_id=vendor.id, stage="Prospect", created_by=user.id, created_at=now
        )
    )


async def change_stage(
    session: AsyncSession, vendor: Vendor, to: str, *, user: User, reason: str | None
) -> str:
    """Move a vendor and return the stage it was in. A refusal names the rule."""
    if not _may_edit(user):
        raise PermissionDenied("This login cannot change vendors.", action="request_po")
    (life,) = await lifecycles(session, [vendor.id])
    error = stage_error(
        from_=vendor.stage,
        to=to,
        can_approve=can_do(user.role, "approve_po"),
        checklist_complete=all(i.done for i in life.items),
        has_live_po=life.has_live_po,
        reason=reason,
        resume_to=life.resume_to,
    )
    if error is not None:
        kind, message = error
        if kind == "permission":
            raise PermissionDenied(message, action="approve_po")
        raise Conflict(message)
    note = (reason or "").strip() or None
    if note and len(note) > 500:
        raise Invalid("The reason is too long (500 characters at most).")
    before = vendor.stage
    # Stamped here, not by the database: ``now()`` is the transaction's start, so two changes in one
    # transaction would tie and the history (and "back to where it was") would have no order.
    now = datetime.now(UTC)
    vendor.stage = to
    vendor.stage_since = now
    vendor.stage_reason = note
    session.add(
        VendorStageHistory(
            vendor_id=vendor.id, stage=to, reason=note, created_by=user.id, created_at=now
        )
    )
    await session.flush()
    return before


async def set_check(
    session: AsyncSession, vendor: Vendor, key: str, done: bool, *, user: User
) -> None:
    """Tick or untick a hand-checked onboarding item. Once approved the checklist is settled."""
    if key not in MANUAL_CHECKS:
        raise Invalid("Only the agreement and the reference check are ticked by hand.")
    if not _may_edit(user):
        raise PermissionDenied("This login cannot change vendors.", action="request_po")
    if vendor.stage not in ("Prospect", "Onboarding"):
        raise Conflict("The checklist is settled once a vendor is approved.")
    row = await session.get(VendorCheck, (vendor.id, key))
    if row is None:
        session.add(VendorCheck(vendor_id=vendor.id, key=key, done=done, updated_by=user.id))
    else:
        row.done = done
        row.updated_by = user.id
    await session.flush()
