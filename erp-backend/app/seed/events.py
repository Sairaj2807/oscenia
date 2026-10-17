"""The prototype's three demo events — EV-01 (the live Aurora Bank gala), EV-02 (Meridian's
launch, already held) and EV-03 (a draft wedding) — with their guests, scans and wishes.

The data is ``events_seed.json``, exported from the prototype by
``erp-frontend/scripts/export-events-seed.mjs`` rather than re-typed, so the counts the
prototype's checks assert (the 16 / 4 / 5 / 6 reconciliation grid of EV-02) hold here too.

Idempotent: an event whose ``event_no`` already exists is left alone, guests and all.
Clients are matched by name, as ``app.seed.demo`` creates them; the backend demo has no
projects yet, so ``project_id`` stays empty. Timestamps in the prototype are Jakarta wall
clock and are read as such.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.domain.ar.models import Client
from app.domain.events import rules
from app.domain.events.models import (
    Event,
    EventCheckpoint,
    EventInvite,
    EventQuestion,
    EventScan,
    EventStatus,
    EventTable,
    EventWish,
    Guest,
    GuestCategory,
    InvitationTemplate,
    InvitedVia,
    RsvpAnswer,
)
from app.domain.ledger.models import DocumentSequence
from app.domain.masters.models import User

SEED_FILE = Path(__file__).with_name("events_seed.json")


@dataclass
class EventsSeedReport:
    events: int = 0
    guests: int = 0
    scans: int = 0
    wishes: int = 0


def _at(text: str | None) -> datetime | None:
    if not text:
        return None
    return datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(get_settings().timezone))


def _seq(keys: list[str]) -> int:
    """Highest number in keys like ``Q-3`` / ``CP-2`` — the prototype seed does not store it."""
    return max((int(k.split("-")[1]) for k in keys), default=0)


def _content(content: dict[str, Any]) -> dict[str, Any]:
    return {k: rules.clean_section(v) for k, v in content.items()}


def _invite(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    return {
        "template_id": raw["template_id"],
        "accent": raw["accent"],
        "on": dict(raw["on"]),
        "content": _content(raw["content"]),
    }


async def seed_events(
    session: AsyncSession, *, created_by: User, now: datetime, data: dict[str, Any] | None = None
) -> EventsSeedReport:
    data = data if data is not None else json.loads(SEED_FILE.read_text(encoding="utf-8"))
    report = EventsSeedReport()
    existing = set((await session.execute(select(Event.event_no))).scalars())
    guests_by_event: dict[str, list[dict[str, Any]]] = {}
    for g in data["guests"]:
        guests_by_event.setdefault(g["event_no"], []).append(g)

    for raw in data["events"]:
        if raw["event_no"] in existing:
            continue
        client_id = None
        if raw["client_name"]:
            client_id = (
                await session.execute(select(Client.id).where(Client.name == raw["client_name"]))
            ).scalar_one_or_none()

        event = Event(
            event_no=raw["event_no"], name=raw["name"], client_id=client_id, project_id=None,
            date=date.fromisoformat(raw["date"]), time=raw["time"], venue=raw["venue"],
            status=EventStatus(raw["status"]),
            rsvp_deadline=date.fromisoformat(raw["rsvp_deadline"]), max_pax=raw["max_pax"],
            rsvp_fields=raw["rsvp_fields"], feedback_url=raw["feedback_url"],
            hold_wishes=raw["hold_wishes"],
            question_seq=max(raw["question_seq"], _seq([q["id"] for q in raw["questions"]])),
            checkpoint_seq=_seq([c["id"] for c in raw["checkpoints"]]), edit_link_version=1,
            created_at=now, updated_at=now, created_by=created_by.id,
        )  # fmt: skip
        session.add(event)
        await session.flush()

        draft = _invite(raw["invite"])
        assert draft is not None
        published = _invite(raw["published"])
        template = (
            await session.get(InvitationTemplate, published["template_id"]) if published else None
        )
        session.add(
            EventInvite(
                event_id=event.id, template_id=draft["template_id"], accent=draft["accent"],
                toggles=draft["on"], content=draft["content"], published=published,
                published_template=template.as_dict() if template else None,
                published_at=now if published else None,
                published_by=created_by.id if published else None,
            )
        )  # fmt: skip
        for i, name in enumerate(raw["tables"], start=1):
            session.add(EventTable(event_id=event.id, name=name, position=i))
        checkpoints = {}
        for i, c in enumerate(raw["checkpoints"], start=1):
            cp = EventCheckpoint(
                event_id=event.id, key=c["id"], position=i, name=c["name"],
                categories=c.get("categories") or [],
            )  # fmt: skip
            session.add(cp)
            checkpoints[c["id"]] = cp
        for i, q in enumerate(raw["questions"], start=1):
            session.add(
                EventQuestion(
                    event_id=event.id, key=q["id"], position=i, label=q.get("label", ""),
                    type=q["type"], options=q.get("options") or [],
                    multi=bool(q.get("multi")) and q["type"] == "choice",
                    required=bool(q.get("required")), attending_only=q.get("attendingOnly", True),
                )
            )  # fmt: skip

        guests: dict[str, Guest] = {}
        for g in guests_by_event.get(raw["event_no"], []):
            guest = Guest(
                id=uuid.uuid4(), event_id=event.id, name=g["name"], phone=g["phone"],
                phone_norm=rules.norm_phone(g["phone"]), email=g["email"],
                category=GuestCategory(rules.to_category(g["category"])),
                on_master_list=g["on_master_list"],
                rsvp=RsvpAnswer(g["rsvp"]) if g["rsvp"] else None, pax=g["pax"],
                allergies=g["allergies"], answers=g["answers"], consent=g["consent"],
                consent_at=_at(g["consent_at"]), responded_at=_at(g["responded_at"]),
                table=rules.clean_table(g["table"]), note=g["note"], note_by=g["note_by"],
                note_at=_at(g["note_at"]), checked_in_at=_at(g["checked_in_at"]),
                walk_in=g["walk_in"], invited_at=_at(g["invited_at"]),
                invited_via=InvitedVia(g["invited_via"]) if g["invited_via"] else None,
                link_version=1, created_at=now,
            )  # fmt: skip
            session.add(guest)
            guests[g["key"]] = guest
        await session.flush()

        for s in data["scans"]:
            if s["event_no"] != raw["event_no"]:
                continue
            session.add(
                EventScan(
                    event_id=event.id, guest_id=guests[s["guest"]].id,
                    checkpoint_id=checkpoints[s["checkpoint"]].id, at=_at(s["at"]),
                )
            )  # fmt: skip
            report.scans += 1
        for w in raw["wishes"]:
            session.add(
                EventWish(
                    event_id=event.id, guest_id=guests[w["guest"]].id if w["guest"] else None,
                    name=w["name"], text=w["text"], at=_at(w["at"]), hidden=w["hidden"],
                    approved=w["approved"],
                )
            )  # fmt: skip
            report.wishes += 1
        await session.flush()
        report.events += 1
        report.guests += len(guests)

    # New events continue after the seeded numbers (EV-04 next), not from EV-01.
    highest = _seq(list((await session.execute(select(Event.event_no))).scalars()))
    seq = (
        await session.execute(
            select(DocumentSequence).where(DocumentSequence.key == "event").with_for_update()
        )
    ).scalar_one()
    seq.next_value = max(seq.next_value, highest + 1)
    await session.flush()
    return report
