"""Reading and writing a client's relationships, and building the relationship calendar.

The rules (what is due, and when) are in :mod:`app.domain.crm.rules`; this module is the storage
around them and the checks a request needs. Every write is by someone allowed to edit clients, is
audited, and refuses what the rules would not understand (a birthday that is not a real ``MM-DD``,
an edition that is not ``YYYY-MM``).

Nothing here sends a message. A greeting is *prepared* (its text and a ``wa.me`` or ``mailto:``
link) and a person marks it sent by hand; the record that it went is what stops a second one.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Sequence
from datetime import date, datetime
from typing import Any
from urllib.parse import quote

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.domain.ar.models import Client, InteractionType
from app.domain.ar.quotations import log_interaction
from app.domain.crm import rules
from app.domain.crm.models import (
    ClientContact,
    ClientEventCycle,
    ClientEventEdition,
    ClientNudgeHandled,
    ClientRelationSettings,
    GreetingLog,
)
from app.domain.crm.schemas import CalendarItem
from app.domain.events import rules as event_rules
from app.domain.masters.models import User
from app.jobs.models import ReminderKind

MAX_CONTACTS = 50
MAX_CYCLES = 20
_EDITION = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


async def get_client(session: AsyncSession, client_id: uuid.UUID) -> Client:
    client = await session.get(Client, client_id)
    if client is None:
        raise NotFound(f"No client {client_id}.")
    return client


# --- reading ----------------------------------------------------------------------------------


async def relations_of(session: AsyncSession, client_id: uuid.UUID) -> dict[str, Any]:
    await get_client(session, client_id)
    settings = await session.get(ClientRelationSettings, client_id)
    contacts = (
        (
            await session.execute(
                select(ClientContact)
                .where(ClientContact.client_id == client_id)
                .order_by(ClientContact.created_at, ClientContact.name)
            )
        )
        .scalars()
        .all()
    )
    cycles = await _cycles(session, [client_id])
    handled = (
        (
            await session.execute(
                select(ClientNudgeHandled)
                .where(ClientNudgeHandled.client_id == client_id)
                .order_by(ClientNudgeHandled.handled_at)
            )
        )
        .scalars()
        .all()
    )
    greetings = (
        (
            await session.execute(
                select(GreetingLog)
                .where(GreetingLog.client_id == client_id)
                .order_by(GreetingLog.marked_at)
            )
        )
        .scalars()
        .all()
    )
    return {
        "contacts": list(contacts),
        "anniversary": settings.anniversary if settings else None,
        "greet_anniversary": settings.greet_anniversary if settings else False,
        "anniversary_channel": settings.anniversary_channel if settings else "whatsapp",
        "nudge_lead_months": settings.nudge_lead_months if settings else 3,
        "cycles": cycles.get(client_id, []),
        "handled_nudges": list(handled),
        "greetings": [
            {
                "id": g.id,
                "kind": g.kind,
                "to": g.to_name,
                "channel": g.channel,
                "occasion_year": g.occasion_year,
                "marked_at": g.marked_at,
            }
            for g in greetings
        ],
    }


async def _cycles(
    session: AsyncSession, client_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[dict[str, Any]]]:
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    rows = (
        (
            await session.execute(
                select(ClientEventCycle)
                .where(ClientEventCycle.client_id.in_(client_ids))
                .order_by(ClientEventCycle.name)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return out
    editions: dict[uuid.UUID, list[str]] = {}
    for cycle_id, edition in (
        await session.execute(
            select(ClientEventEdition.cycle_id, ClientEventEdition.edition)
            .where(ClientEventEdition.cycle_id.in_([r.id for r in rows]))
            .order_by(ClientEventEdition.edition)
        )
    ).all():
        editions.setdefault(cycle_id, []).append(edition)
    for cycle in rows:
        out.setdefault(cycle.client_id, []).append(
            {"id": cycle.id, "name": cycle.name, "history": editions.get(cycle.id, [])}
        )
    return out


# --- contacts ---------------------------------------------------------------------------------


def _clean_contact(values: dict[str, Any]) -> dict[str, Any]:
    out = dict(values)
    for key in ("name", "role", "phone", "email"):
        if key in out and out[key] is not None:
            out[key] = " ".join(str(out[key]).split()) if key != "email" else out[key].strip()
    if "name" in out and not out["name"]:
        raise Invalid("A contact needs a name.")
    if out.get("email") and not event_rules.is_email(out["email"]):
        raise Invalid("That email address is not valid.")
    if "birthday" in out:
        if out["birthday"] in ("", None):
            out["birthday"] = None
        elif not rules.is_month_day(out["birthday"]):
            raise Invalid("A birthday is month and day as MM-DD, for example 07-28.")
    return out


async def add_contact(
    session: AsyncSession, client_id: uuid.UUID, values: dict[str, Any]
) -> ClientContact:
    await get_client(session, client_id)
    existing = (
        await session.execute(select(ClientContact.id).where(ClientContact.client_id == client_id))
    ).all()
    if len(existing) >= MAX_CONTACTS:
        raise Conflict(f"A client can have up to {MAX_CONTACTS} contacts.")
    contact = ClientContact(client_id=client_id, **_clean_contact(values))
    session.add(contact)
    await session.flush()
    await session.refresh(contact)
    return contact


async def _contact(
    session: AsyncSession, client_id: uuid.UUID, contact_id: uuid.UUID
) -> ClientContact:
    contact = await session.get(ClientContact, contact_id)
    if contact is None or contact.client_id != client_id:
        raise NotFound("There is no such contact on this client.")
    return contact


async def edit_contact(
    session: AsyncSession, client_id: uuid.UUID, contact_id: uuid.UUID, changes: dict[str, Any]
) -> tuple[ClientContact, dict[str, Any], dict[str, Any]]:
    contact = await _contact(session, client_id, contact_id)
    clean = _clean_contact({k: v for k, v in changes.items() if v is not None or k == "birthday"})
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for key, value in clean.items():
        if getattr(contact, key) != value:
            before[key], after[key] = getattr(contact, key), value
            setattr(contact, key, value)
    await session.flush()
    await session.refresh(contact)
    return contact, before, after


async def remove_contact(
    session: AsyncSession, client_id: uuid.UUID, contact_id: uuid.UUID
) -> ClientContact:
    contact = await _contact(session, client_id, contact_id)
    await session.delete(contact)
    await session.flush()
    return contact


# --- settings ---------------------------------------------------------------------------------


async def edit_settings(
    session: AsyncSession, client_id: uuid.UUID, changes: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    await get_client(session, client_id)
    row = await session.get(ClientRelationSettings, client_id)
    if row is None:
        row = ClientRelationSettings(client_id=client_id)
        session.add(row)
        await session.flush()
        await session.refresh(row)
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for key, value in changes.items():
        # A null clears the anniversary; for every other field it means "leave it".
        if value is None and key != "anniversary":
            continue
        if getattr(row, key) != value:
            before[key], after[key] = _plain(getattr(row, key)), _plain(value)
            setattr(row, key, value)
    await session.flush()
    return before, after


def _plain(value: Any) -> Any:
    return value.isoformat() if isinstance(value, date) else value


# --- event cycles -----------------------------------------------------------------------------


def _clean_history(history: Sequence[str]) -> list[str]:
    bad = [h for h in history if not _EDITION.match(h)]
    if bad:
        raise Invalid(f"An edition is a year and month as YYYY-MM, not {bad[0]!r}.")
    return sorted(set(history))


def _clean_cycle_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise Invalid("A recurring event needs a name.")
    if ":" in cleaned:
        raise Invalid("An event name cannot contain a colon.")
    return cleaned


async def add_cycle(
    session: AsyncSession, client_id: uuid.UUID, name: str, history: Sequence[str]
) -> dict[str, Any]:
    await get_client(session, client_id)
    cleaned = _clean_cycle_name(name)
    months = _clean_history(history)
    have = (
        (
            await session.execute(
                select(ClientEventCycle).where(ClientEventCycle.client_id == client_id)
            )
        )
        .scalars()
        .all()
    )
    if len(have) >= MAX_CYCLES:
        raise Conflict(f"A client can have up to {MAX_CYCLES} recurring events.")
    if any(c.name.lower() == cleaned.lower() for c in have):
        raise Conflict(f"{cleaned} is already one of this client's recurring events.")
    cycle = ClientEventCycle(client_id=client_id, name=cleaned)
    session.add(cycle)
    await session.flush()
    session.add_all([ClientEventEdition(cycle_id=cycle.id, edition=m) for m in months])
    await session.flush()
    return {"id": cycle.id, "name": cycle.name, "history": months}


async def _cycle(
    session: AsyncSession, client_id: uuid.UUID, cycle_id: uuid.UUID
) -> ClientEventCycle:
    cycle = await session.get(ClientEventCycle, cycle_id)
    if cycle is None or cycle.client_id != client_id:
        raise NotFound("There is no such recurring event on this client.")
    return cycle


async def edit_cycle(
    session: AsyncSession,
    client_id: uuid.UUID,
    cycle_id: uuid.UUID,
    *,
    name: str | None,
    history: Sequence[str] | None,
) -> dict[str, Any]:
    cycle = await _cycle(session, client_id, cycle_id)
    if name is not None:
        cleaned = _clean_cycle_name(name)
        clash = (
            await session.execute(
                select(ClientEventCycle.id)
                .where(
                    ClientEventCycle.client_id == client_id,
                    ClientEventCycle.id != cycle.id,
                )
                .where(ClientEventCycle.name.ilike(cleaned))
            )
        ).first()
        if clash is not None:
            raise Conflict(f"{cleaned} is already one of this client's recurring events.")
        if cleaned != cycle.name:
            # A nudge already acted on is keyed by the old name; carry the keys across.
            await _rename_handled(session, client_id, cycle.name, cleaned)
            cycle.name = cleaned
    if history is not None:
        months = _clean_history(history)
        await session.execute(
            delete(ClientEventEdition).where(ClientEventEdition.cycle_id == cycle.id)
        )
        session.add_all([ClientEventEdition(cycle_id=cycle.id, edition=m) for m in months])
    await session.flush()
    out = await _cycles(session, [client_id])
    return next(c for c in out[client_id] if c["id"] == cycle.id)


async def _rename_handled(session: AsyncSession, client_id: uuid.UUID, old: str, new: str) -> None:
    rows = (
        (
            await session.execute(
                select(ClientNudgeHandled).where(
                    ClientNudgeHandled.client_id == client_id,
                    ClientNudgeHandled.key.like(f"{old}:%"),
                )
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.key = f"{new}:{row.key[len(old) + 1 :]}"


async def remove_cycle(
    session: AsyncSession, client_id: uuid.UUID, cycle_id: uuid.UUID
) -> ClientEventCycle:
    cycle = await _cycle(session, client_id, cycle_id)
    await session.delete(cycle)
    await session.flush()
    return cycle


# --- nudges -----------------------------------------------------------------------------------


async def handle_nudge(
    session: AsyncSession,
    client_id: uuid.UUID,
    *,
    key: str,
    note: str,
    user: User,
    today: date,
    now: datetime,
) -> ClientNudgeHandled:
    """Somebody reached out about an edition: it leaves the calendar and is noted on the client.

    The key must be one the calendar would show for this client today. A made-up key is refused, so
    nothing can be marked handled that was never due.
    """
    rel = await relations_of(session, client_id)
    due = {
        f"{c['name']}:{n['edition']}": n
        for c in rel["cycles"]
        if (n := rules.next_nudge(c["history"], rel["nudge_lead_months"], today.isoformat()))
    }
    if key not in due:
        raise Invalid("That is not a nudge this client has coming up.")
    if any(h.key == key for h in rel["handled_nudges"]):
        raise Conflict("That nudge was already handled.")

    title = key.rsplit(":", 1)[0]
    text = note.strip() or f"Event-cycle nudge: asked about {title} {due[key]['edition'][:4]}."
    row = ClientNudgeHandled(
        client_id=client_id, key=key, note=text, handled_at=now, handled_by=user.id
    )
    session.add(row)
    await session.flush()
    await log_interaction(
        session, client_id, user=user, note=text, on=today, type_=InteractionType.CALL
    )
    return row


# --- greetings --------------------------------------------------------------------------------


def _prepared(
    item: dict[str, Any], client: Client, contact: ClientContact | None
) -> dict[str, Any]:
    """The text and the links that open a greeting ready to send."""
    kind = item["kind"]
    message = rules.greeting_text(kind, client=item["client"], title=item["title"])
    phone = contact.phone if contact is not None else (client.phone or "")
    email = contact.email if contact is not None else (client.email or "")
    digits = event_rules.norm_phone(phone)
    whatsapp = (
        f"https://wa.me/{digits}?text={quote(message)}"
        if len(digits) >= event_rules.MIN_PHONE_DIGITS
        else None
    )
    subject = "Happy birthday" if kind == rules.KIND_BIRTHDAY else "Happy anniversary"
    mail = (
        f"mailto:{quote(email)}?subject={quote(subject)}&body={quote(message)}"
        if event_rules.is_email(email)
        else None
    )
    return {"message": message, "whatsapp_url": whatsapp, "email_url": mail}


async def mark_greeting_sent(
    session: AsyncSession,
    client_id: uuid.UUID,
    *,
    kind: str,
    to: str,
    channel: str,
    year: int,
    user: User,
    today: date,
    now: datetime,
) -> GreetingLog:
    """Record that a greeting went, by hand. One per person per occasion per year."""
    client = await get_client(session, client_id)
    if abs(year - today.year) > 1:
        raise Invalid("That year is too far from today to be a greeting that is due.")
    if kind == rules.KIND_BIRTHDAY:
        known = (
            await session.execute(
                select(ClientContact.id).where(
                    ClientContact.client_id == client_id,
                    ClientContact.name == to,
                    ClientContact.birthday.is_not(None),
                )
            )
        ).first()
        if known is None:
            raise Invalid(f"{to} is not a contact with a birthday on this client.")
    elif to != client.name:
        raise Invalid("An anniversary greeting is for the company itself.")
    else:
        settings = await session.get(ClientRelationSettings, client_id)
        if settings is None or settings.anniversary is None:
            raise Invalid("This client has no anniversary recorded.")

    clash = (
        await session.execute(
            select(GreetingLog.id).where(
                GreetingLog.client_id == client_id,
                GreetingLog.kind == kind,
                GreetingLog.to_name == to,
                GreetingLog.occasion_year == year,
            )
        )
    ).first()
    if clash is not None:
        raise Conflict(f"{to} has already been greeted for {year}.")
    row = GreetingLog(
        client_id=client_id,
        kind=kind,
        to_name=to,
        channel=channel,
        occasion_year=year,
        marked_at=now,
        marked_by=user.id,
    )
    session.add(row)
    await session.flush()
    return row


# --- the calendar -----------------------------------------------------------------------------


async def calendar(
    session: AsyncSession, *, today: date, days: int, client_id: uuid.UUID | None = None
) -> list[CalendarItem]:
    """Everything coming up across clients (or one), soonest first, with greetings prepared."""
    stmt = select(Client).order_by(Client.client_no)
    if client_id is not None:
        stmt = stmt.where(Client.id == client_id)
    clients = list((await session.execute(stmt)).scalars().all())
    if not clients:
        return []
    ids = [c.id for c in clients]

    settings = {
        s.client_id: s
        for s in (
            await session.execute(
                select(ClientRelationSettings).where(ClientRelationSettings.client_id.in_(ids))
            )
        ).scalars()
    }
    contacts: dict[uuid.UUID, list[ClientContact]] = {}
    for contact in (
        await session.execute(
            select(ClientContact)
            .where(ClientContact.client_id.in_(ids))
            .order_by(ClientContact.created_at, ClientContact.name)
        )
    ).scalars():
        contacts.setdefault(contact.client_id, []).append(contact)
    cycles = await _cycles(session, ids)
    handled: dict[uuid.UUID, list[str]] = {}
    for hid, hkey in (
        await session.execute(
            select(ClientNudgeHandled.client_id, ClientNudgeHandled.key).where(
                ClientNudgeHandled.client_id.in_(ids)
            )
        )
    ).all():
        handled.setdefault(hid, []).append(hkey)
    sent = {
        (g.client_id, g.kind, g.to_name, g.occasion_year)
        for g in (
            await session.execute(select(GreetingLog).where(GreetingLog.client_id.in_(ids)))
        ).scalars()
    }

    relations: dict[str, dict[str, Any]] = {}
    for client in clients:
        st = settings.get(client.id)
        relations[str(client.id)] = {
            "nudgeLeadMonths": st.nudge_lead_months if st else 3,
            "cycles": [
                {"name": c["name"], "history": c["history"]} for c in cycles.get(client.id, [])
            ],
            "handledNudges": handled.get(client.id, []),
            "pics": [
                {"id": str(p.id), "name": p.name, "role": p.role, "birthday": p.birthday}
                for p in contacts.get(client.id, [])
            ],
            "anniversary": st.anniversary.isoformat() if st and st.anniversary else None,
        }

    raw = rules.relationship_calendar(
        [{"id": str(c.id), "name": c.name} for c in clients], relations, today.isoformat(), days
    )
    by_id = {str(c.id): c for c in clients}
    by_contact = {str(p.id): p for plist in contacts.values() for p in plist}
    out: list[CalendarItem] = []
    for item in raw:
        client = by_id[item["clientId"]]
        year = int(item["date"][:4])
        base: dict[str, Any] = {
            "kind": item["kind"],
            "client_id": client.id,
            "client_no": client.client_no,
            "client": client.name,
            "date": date.fromisoformat(item["date"]),
            "in_days": item["inDays"],
            "key": item.get("key"),
            "title": item["title"],
            "detail": item.get("detail") or "",
        }
        if item["kind"] == rules.KIND_NUDGE:
            out.append(CalendarItem(**base))
            continue
        st = settings.get(client.id)
        person: ClientContact | None
        if item["kind"] == rules.KIND_BIRTHDAY:
            person = by_contact.get(item["picId"])
            name = item["title"]
            greet, channel = (person.greet, person.channel) if person else (False, None)
        else:
            person = None
            name = client.name
            greet = bool(st and st.greet_anniversary)
            channel = st.anniversary_channel if st else None
        out.append(
            CalendarItem(
                **base,
                pic_id=uuid.UUID(item["picId"]) if item.get("picId") else None,
                greet=greet,
                channel=channel,
                already_sent=(client.id, item["kind"], name, year) in sent,
                **_prepared(item, client, person),
            )
        )
    return out


# --- the daily scan ---------------------------------------------------------------------------


async def due_today(session: AsyncSession, on: date) -> list[dict[str, Any]]:
    """What the daily scan should raise a reminder for today, as keyword arguments for it.

    A contact's birthday, a recorded company anniversary (from its first year on), and an
    event-cycle nudge whose day is today and which nobody has handled. A nudge that is already
    overdue is not raised again each morning: it stays on the calendar, where overdue ones belong.
    """
    today = on.isoformat()
    clients = {c.id: c for c in (await session.execute(select(Client))).scalars()}
    out: list[dict[str, Any]] = []

    for contact in (await session.execute(select(ClientContact))).scalars():
        client = clients.get(contact.client_id)
        if client is None or not contact.birthday:
            continue
        if rules.next_occurrence(contact.birthday, today) != today:
            continue
        out.append(
            {
                "kind": ReminderKind.BIRTHDAY,
                "subject": f"Birthday today — {contact.name} ({client.name})",
                "detail": contact.role or None,
                "ref": f"{client.client_no}-pic-{contact.id.hex[:12]}",
                "client_id": client.id,
            }
        )

    settings = {
        s.client_id: s for s in (await session.execute(select(ClientRelationSettings))).scalars()
    }
    for client_id, st in settings.items():
        client = clients.get(client_id)
        if client is None or st.anniversary is None:
            continue
        if rules.next_occurrence(st.anniversary.isoformat(), today) != today:
            continue
        years = on.year - st.anniversary.year
        if years < 1:
            continue
        out.append(
            {
                "kind": ReminderKind.ANNIVERSARY,
                "subject": f"Anniversary today — {client.name}",
                "detail": f"{years} years with Oscenia",
                "ref": f"{client.client_no}-anniversary-{on.year}",
                "client_id": client.id,
            }
        )

    cycles = await _cycles(session, list(clients))
    handled = {
        (h.client_id, h.key) for h in (await session.execute(select(ClientNudgeHandled))).scalars()
    }
    for client_id, client_cycles in cycles.items():
        client = clients[client_id]
        lead = settings[client_id].nudge_lead_months if client_id in settings else 3
        for cycle in client_cycles:
            nudge = rules.next_nudge(cycle["history"], lead, today)
            if nudge is None or nudge["nudge_on"] != today:
                continue
            key = f"{cycle['name']}:{nudge['edition']}"
            if (client_id, key) in handled:
                continue
            out.append(
                {
                    "kind": ReminderKind.NUDGE,
                    "subject": (
                        f"Time to nudge {client.name} about {cycle['name']} "
                        f"{nudge['edition'][:4]}"
                    ),
                    "detail": (
                        f"Usually in {rules.month_name(nudge['month'])}; "
                        f"reach out {lead} months ahead"
                    ),
                    "ref": f"{client.client_no}-nudge-{cycle['id'].hex[:8]}-{nudge['edition']}",
                    "client_id": client.id,
                }
            )
    return out
