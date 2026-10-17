"""The audit log: who, what, when, before and after — and nobody can rewrite it."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import request_id_var
from app.domain.audit.models import AuditEvent
from app.domain.audit.service import changed, record_audit, snapshot
from app.domain.masters.models import User


async def _ceo(db: AsyncSession) -> User:
    return (
        await db.execute(select(User).where(User.email == "rahmat@oscenia.co.id"))
    ).scalar_one()


def test_only_changed_fields_are_kept() -> None:
    before = {"status": "draft", "name": "Gala", "max_pax": 4}
    after = {"status": "published", "name": "Gala", "max_pax": 4}
    assert changed(before, after) == ({"status": "draft"}, {"status": "published"})


def test_a_create_or_delete_keeps_its_whole_side() -> None:
    assert changed(None, {"name": "Gala"}) == (None, {"name": "Gala"})
    assert changed({"name": "Gala"}, None) == ({"name": "Gala"}, None)


def test_snapshot_reads_the_named_attributes() -> None:
    row = SimpleNamespace(status="draft", name="Gala", secret="x")
    assert snapshot(row, ["status", "name"]) == {"status": "draft", "name": "Gala"}


async def test_a_change_is_recorded_with_who_what_when_and_both_sides(db: AsyncSession) -> None:
    ceo = await _ceo(db)
    token = request_id_var.set("req-123")
    try:
        event = await record_audit(
            db,
            actor=ceo,
            action="invitation.publish",
            entity_type="event",
            entity_id="EV-01",
            before={"status": "draft", "deadline": date(2026, 8, 1), "fee": Decimal("12.50")},
            after={"status": "published", "deadline": date(2026, 8, 1), "fee": Decimal("15.00")},
            detail={"clamped_deadline": False},
        )
    finally:
        request_id_var.reset(token)

    assert event is not None
    row = (await db.execute(select(AuditEvent).where(AuditEvent.id == event.id))).scalar_one()
    assert row.actor_user_id == ceo.id and row.actor_label == "rahmat@oscenia.co.id"
    assert row.action == "invitation.publish"
    assert (row.entity_type, row.entity_id) == ("event", "EV-01")
    assert row.before == {"status": "draft", "fee": "12.50"}, "money stays a string"
    assert row.after == {"status": "published", "fee": "15.00"}
    assert row.detail == {"clamped_deadline": False}
    assert row.request_id == "req-123"
    assert row.at is not None


async def test_a_public_actor_is_named_without_a_user(db: AsyncSession) -> None:
    event = await record_audit(
        db, actor_label="guest G-014", action="guest.rsvp", entity_type="guest",
        entity_id="G-014", after={"rsvp": "yes", "pax": 2},
    )
    assert event is not None and event.actor_user_id is None
    assert event.actor_label == "guest G-014"


async def test_any_valid_email_fits_as_the_actor(db: AsyncSession) -> None:
    long_label = "a" * 64 + "@" + "b" * 180 + ".com"
    event = await record_audit(
        db, actor_label=long_label, action="x.y", entity_type="event", entity_id="EV-01",
        after={"a": 1},
    )
    assert event is not None and event.actor_label == long_label


async def test_an_actor_is_required(db: AsyncSession) -> None:
    with pytest.raises(ValueError):
        await record_audit(db, action="x.y", entity_type="event", entity_id="EV-01")


async def test_a_save_that_changed_nothing_writes_nothing(db: AsyncSession) -> None:
    ceo = await _ceo(db)
    same = {"status": "draft"}
    assert (
        await record_audit(
            db, actor=ceo, action="event.update", entity_type="event", entity_id="EV-01",
            before=same, after=dict(same),
        )
        is None
    )


@pytest.mark.parametrize(
    "statement",
    ["UPDATE audit_log SET action = 'forged'", "DELETE FROM audit_log", "TRUNCATE audit_log"],
)
async def test_the_log_cannot_be_rewritten_even_in_raw_sql(
    db_immediate: AsyncSession, statement: str
) -> None:
    ceo = await _ceo(db_immediate)
    await record_audit(
        db_immediate, actor=ceo, action="user.deactivate", entity_type="user",
        entity_id=str(ceo.id), before={"active": True}, after={"active": False},
    )
    with pytest.raises(DBAPIError, match="append-only"):
        await db_immediate.execute(text(statement))
